'use strict';

/* ===========================================================================
   AI-OS // consent window bridge
   ---------------------------------------------------------------------------
   Deliberately tiny. This window exists so that approving a privileged action
   requires a keystroke or click inside a surface the main process created. It
   can read the pending request and answer it once; it can do nothing else.
   =========================================================================== */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('consent', {
  payload: () => ipcRenderer.invoke('consent:payload'),
  respond: (granted) => ipcRenderer.send('consent:respond', !!granted),
  /* Which rows of a batch are still ticked. Sent as it changes rather than with
     the answer, so the approval stays the one-way boolean it has always been. */
  keep: (indices) => ipcRenderer.send('consent:keep',
    Array.isArray(indices) ? indices.map(Number).filter(Number.isInteger) : [])
});
