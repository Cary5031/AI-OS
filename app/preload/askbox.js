'use strict';

/* ===========================================================================
   AI-OS // askBox bridge
   ---------------------------------------------------------------------------
   Deliberately tiny, like consent.js beside it. The confirmation layer exists
   so that answering a question requires a click or a keystroke inside a
   surface the main process created. It can read the one question it was
   opened for and answer it once; it can do nothing else.
   =========================================================================== */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('askbox', {
  payload: () => ipcRenderer.invoke('askbox:payload'),
  respond: (index) => ipcRenderer.send('askbox:respond', Number(index))
});
