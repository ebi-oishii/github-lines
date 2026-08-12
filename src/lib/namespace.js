/* Shared namespace. Loaded first in every context (content script, service
   worker via importScripts, options page). Every other lib/ and content/ file
   hangs its exports off this object. */
globalThis.GHL = globalThis.GHL || {};
