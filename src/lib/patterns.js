/* File classification: which paths to skip, and how many bytes a line of a
   given language costs. Used to turn the byte sizes from the tree API into a
   first-pass line estimate before exact counts arrive. */
(function (GHL) {
  'use strict';

  /* Never fetched, never counted: the content has no meaningful line structure.
     These still take up bytes, so counting them would make the bars lie. */
  const BINARY_EXT = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tif', 'tiff',
    'woff', 'woff2', 'ttf', 'eot', 'otf',
    'pdf', 'zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', '7z', 'rar',
    'mp3', 'mp4', 'mov', 'avi', 'wav', 'ogg', 'webm', 'flac', 'm4a',
    'psd', 'ai', 'sketch', 'fig', 'xd',
    'jar', 'war', 'class', 'so', 'dylib', 'dll', 'exe', 'bin', 'o', 'a',
    'wasm', 'pyc', 'pyo', 'parquet', 'db', 'sqlite', 'sqlite3', 'mo',
    'ttc', 'dat', 'pack', 'idx', 'keystore', 'jks', 'p12', 'pfx',
  ]);

  /* Default "generated / vendored" globs. Toggleable in options — some teams
     genuinely want lockfiles counted, most do not. */
  const DEFAULT_EXCLUDES = [
    '**/node_modules/**',
    '**/vendor/**',
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    '**/.next/**',
    '**/.nuxt/**',
    '**/target/**',
    '**/coverage/**',
    '**/__snapshots__/**',
    '**/*.min.js',
    '**/*.min.css',
    '**/*.map',
    '**/*.svg',
    '**/*.snap',
    '**/package-lock.json',
    '**/yarn.lock',
    '**/pnpm-lock.yaml',
    '**/composer.lock',
    '**/Gemfile.lock',
    '**/Cargo.lock',
    '**/poetry.lock',
    '**/go.sum',
    '**/*.pb.go',
    '**/*_pb2.py',
    '**/*_pb2_grpc.py',
    '**/*.g.dart',
    '**/*.freezed.dart',
    '**/*.generated.*',
    '**/generated/**',
  ];

  /* Median bytes per line, by extension. Only used until the real count for a
     file arrives; `learnRatio` below refines these per repository. */
  const BYTES_PER_LINE = {
    js: 32, jsx: 32, mjs: 32, cjs: 32,
    ts: 33, tsx: 33,
    py: 30, rb: 28, go: 28, rs: 32, java: 35, kt: 33, swift: 33,
    c: 28, h: 26, cpp: 30, hpp: 28, cc: 30, cs: 33, m: 30, mm: 30,
    php: 32, scala: 34, clj: 28, ex: 28, exs: 28, erl: 30, hs: 30,
    dart: 32, lua: 26, pl: 30, sh: 26, bash: 26, zsh: 26, fish: 26,
    sql: 30, graphql: 24, proto: 28,
    html: 42, htm: 42, vue: 34, svelte: 34, astro: 34,
    css: 26, scss: 26, sass: 24, less: 26, styl: 24,
    json: 26, yaml: 28, yml: 28, toml: 28, ini: 24, xml: 40, csv: 40,
    md: 46, mdx: 46, rst: 44, txt: 44, adoc: 44,
    tf: 30, tfvars: 28, dockerfile: 30, makefile: 28, gradle: 30,
  };

  const DEFAULT_BYTES_PER_LINE = 32;

  function extOf(path) {
    const base = path.slice(path.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    if (dot <= 0) return base.toLowerCase(); // Dockerfile, Makefile, LICENSE...
    return base.slice(dot + 1).toLowerCase();
  }

  function isBinary(path) {
    return BINARY_EXT.has(extOf(path));
  }

  /* Minimal glob → RegExp. Supports **, *, ? and nothing else, which covers
     every pattern anyone realistically writes for this. */
  function globToRegExp(glob) {
    let out = '';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*') {
        if (glob[i + 1] === '*') {
          // `**/` matches zero or more leading path segments.
          if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
          else { out += '.*'; i += 1; }
        } else {
          out += '[^/]*';
        }
      } else if (c === '?') {
        out += '[^/]';
      } else if ('\\^$.|+()[]{}'.includes(c)) {
        out += '\\' + c;
      } else {
        out += c;
      }
    }
    return new RegExp('^' + out + '$', 'i');
  }

  function compileExcludes(patterns) {
    const compiled = [];
    for (const p of patterns || []) {
      const trimmed = String(p).trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      try { compiled.push(globToRegExp(trimmed)); } catch (_) { /* skip bad glob */ }
    }
    return function isExcluded(path) {
      for (const re of compiled) if (re.test(path)) return true;
      return false;
    };
  }

  /* Per-repo learned ratios, so estimates for not-yet-fetched files converge on
     the repo's real style rather than the generic table above. */
  function createRatioLearner() {
    const samples = new Map(); // ext -> { bytes, lines }

    return {
      observe(path, bytes, lines) {
        if (!lines || lines < 5 || !bytes) return;
        const ext = extOf(path);
        const cur = samples.get(ext) || { bytes: 0, lines: 0 };
        cur.bytes += bytes;
        cur.lines += lines;
        samples.set(ext, cur);
      },
      bytesPerLine(path) {
        const ext = extOf(path);
        const s = samples.get(ext);
        // Require a little evidence before trusting the learned value.
        if (s && s.lines >= 40) return s.bytes / s.lines;
        return BYTES_PER_LINE[ext] || DEFAULT_BYTES_PER_LINE;
      },
      estimate(path, bytes) {
        return Math.max(1, Math.round(bytes / this.bytesPerLine(path)));
      },
    };
  }

  /* --- .gitattributes -------------------------------------------------- */

  /* gitattributes patterns follow gitignore syntax: a pattern with no slash
     matches a basename at any depth, one with a slash is anchored to the
     directory containing the .gitattributes file. */
  function gitattrToRegExp(pattern, baseDir) {
    let p = pattern;
    let anchored = false;

    if (p.startsWith('/')) { p = p.slice(1); anchored = true; }
    if (p.includes('/')) anchored = true;

    let dirOnly = false;
    if (p.endsWith('/')) { p = p.slice(0, -1); dirOnly = true; }

    let glob = anchored ? p : `**/${p}`;
    if (baseDir) glob = `${baseDir}/${glob}`;
    if (dirOnly) glob = `${glob}/**`;

    return globToRegExp(glob);
  }

  /* Returns a predicate marking paths that GitHub's own linguist would treat as
     generated or vendored — the same signal `github-better-line-counts` uses,
     and more accurate than any hardcoded glob list because the repo declares it. */
  function parseGitattributes(text, baseDir) {
    const rules = []; // { re, generated: bool|null, vendored: bool|null }

    for (const rawLine of String(text).split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      // `pattern attr1 attr2=value ...`
      const tokens = line.split(/\s+/);
      const pattern = tokens[0];
      const attrs = tokens.slice(1);
      if (!pattern || !attrs.length) continue;

      let generated = null;
      let vendored = null;

      for (const attr of attrs) {
        const negated = attr.startsWith('-');
        const body = negated ? attr.slice(1) : attr;
        const [name, value] = body.split('=');
        const on = negated ? false : (value === undefined ? true : value === 'true');

        if (name === 'linguist-generated') generated = on;
        else if (name === 'linguist-vendored') vendored = on;
      }

      if (generated === null && vendored === null) continue;

      try {
        rules.push({ re: gitattrToRegExp(pattern, baseDir), generated, vendored });
      } catch (_) { /* skip unparseable pattern */ }
    }

    return rules;
  }

  /* Later rules win, matching git's own precedence. */
  function makeLinguistMatcher(allRules) {
    if (!allRules.length) return () => false;
    return function isGeneratedOrVendored(path) {
      let flagged = false;
      for (const rule of allRules) {
        if (!rule.re.test(path)) continue;
        if (rule.generated !== null) flagged = rule.generated;
        if (rule.vendored !== null) flagged = rule.vendored;
      }
      return flagged;
    };
  }

  GHL.patterns = {
    BINARY_EXT,
    DEFAULT_EXCLUDES,
    gitattrToRegExp,
    parseGitattributes,
    makeLinguistMatcher,
    BYTES_PER_LINE,
    DEFAULT_BYTES_PER_LINE,
    extOf,
    isBinary,
    globToRegExp,
    compileExcludes,
    createRatioLearner,
  };
})(globalThis.GHL);
