/* The same suite, against the newest built portable exe in a throwaway
   directory -- the only way to exercise a genuine first run.

   A separate entry rather than a flag on the other one: setting an environment
   variable inline (`VAR=1 node ...`) is not portable to Windows shells, and
   passing a flag through `npm run` into `node --test` into the test file does
   not reliably arrive. A switch that silently does nothing would make the
   packaged run look like it passed while testing the source tree. */

process.env.AIOS_E2E_PACKAGED = '1';
await import('./run.mjs');
