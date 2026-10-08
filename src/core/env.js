/**
 * env.js — module resolution helper.
 *
 * In the browser, modules are loaded through the import map in index.html, so
 * `import * as THREE from 'three'` works. Under Node (used by the offline
 * verification harness) bare specifiers resolve from node_modules directly.
 * This module exists so that both environments load the exact same files and
 * there is one place to look if resolution ever breaks.
 */
export const THREE_PATH = '/node_modules/three/build/three.module.js';
export const ADDONS_PATH = '/node_modules/three/examples/jsm/';
