import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = dirname(fileURLToPath(import.meta.url));

// pcm-worklet.js is loaded by the browser via audioContext.audioWorklet.addModule().
// It must exist as a plain, unbundled static file next to offscreen.html, so we
// copy it verbatim instead of letting Rollup process it as a module import.
function copyPcmWorkletPlugin() {
  return {
    name: 'copy-pcm-worklet',
    closeBundle() {
      const outDir = resolve(__dirname, 'dist/offscreen');
      mkdirSync(outDir, { recursive: true });
      copyFileSync(
        resolve(__dirname, 'src/offscreen/pcm-worklet.js'),
        resolve(outDir, 'pcm-worklet.js')
      );
    },
  };
}

// vosk-browser (used by src/offscreen/asr-engine.js) normally spawns its WASM
// engine in a Web Worker created from a `blob:` URL it builds internally. MV3
// extension pages reject `blob:` as a worker-src CSP value outright (Chrome
// refuses to even load the extension), so that blob-based worker can never run
// here. Instead, we extract the exact same worker source (which vosk-browser
// embeds as a base64 string in its bundle) at build time and ship it as a real,
// same-origin file at dist/offscreen/vosk-worker.js. asr-engine.js then talks to
// it directly with a small hand-rolled version of vosk-browser's own
// postMessage protocol (see asr-engine.js), instead of using vosk-browser's
// Model/KaldiRecognizer classes (which always create their blob-based worker).
//
// The extracted worker also contains exactly one `new Function(...)` call —
// Emscripten's embind `createNamedFunction(name, body)` helper, which only
// exists to give WASM-bound functions a nicer `.name` for stack traces. MV3
// extension pages don't allow 'unsafe-eval' in script-src (only
// 'wasm-unsafe-eval', which covers WebAssembly compilation but not plain
// eval()/new Function()) and there is no CSP override that can add it, so this
// call throws a CSP violation the moment the worker initializes. We patch it
// out here with a functionally-identical version that skips naming the
// function (purely cosmetic — has zero effect on behavior).
function patchOutEval(source) {
  const startMarker = 'function createNamedFunction(name,body){';
  const endMarker = ')(body)}';
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) return source; // nothing to patch (or already patched)
  const endIdx = source.indexOf(endMarker, startIdx) + endMarker.length;
  const replacement =
    'function createNamedFunction(name,body){return function(){return body.apply(this,arguments)}}';
  return source.slice(0, startIdx) + replacement + source.slice(endIdx);
}

// A second, more essential use of dynamic code generation: embind's
// craftInvokerFunction() builds a specialized invoker per bound C++
// function/method signature by doing `new_(Function, args1).apply(null, args2)`
// — effectively `new Function(...)` — to JIT-compile an optimized closure.
// Unlike createNamedFunction, this one is NOT cosmetic (it's how every single
// embind-bound method actually gets called), so we can't just no-op it. This
// replaces it with a generic, non-eval implementation that performs the exact
// same steps (argument count check, toWireType conversion, invoking the C++
// function via cppInvokerFunc, running destructors, fromWireType conversion)
// using a plain closure over `arguments` instead of a dynamically-compiled,
// named-parameter function. Functionally identical, just not JIT-specialized.
function patchCraftInvokerFunction(source) {
  const startMarker =
    'function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){';
  const endMarker = 'return invokerFunction}';
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) return source; // nothing to patch (or already patched)
  const endIdx = source.indexOf(endMarker, startIdx) + endMarker.length;

  const replacement = `function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){
    var argCount=argTypes.length;
    if(argCount<2){throwBindingError("argTypes array size mismatch! Must at least get return value and 'this' types!");}
    var isClassMethodFunc=argTypes[1]!==null&&classType!==null;
    var needsDestructorStack=false;
    for(var i=1;i<argTypes.length;++i){if(argTypes[i]!==null&&argTypes[i].destructorFunction===undefined){needsDestructorStack=true;break}}
    var returns=argTypes[0].name!=="void";
    var expectedArgCount=argCount-2;
    var retType=argTypes[0];
    var classParam=argTypes[1];
    return function(){
      if(arguments.length!==expectedArgCount){throwBindingError("function "+humanName+" called with "+arguments.length+" arguments, expected "+expectedArgCount+" args!");}
      var destructors=needsDestructorStack?[]:null;
      var dtorStack=needsDestructorStack?destructors:null;
      var thisWired;
      if(isClassMethodFunc){thisWired=classParam.toWireType(dtorStack,this);}
      var wiredArgs=new Array(expectedArgCount);
      for(var i=0;i<expectedArgCount;++i){wiredArgs[i]=argTypes[i+2].toWireType(dtorStack,arguments[i]);}
      var invokerArgs=isClassMethodFunc?[thisWired].concat(wiredArgs):wiredArgs;
      var rv=cppInvokerFunc.apply(null,[cppTargetFunc].concat(invokerArgs));
      if(needsDestructorStack){runDestructors(destructors);}
      else{
        var start=isClassMethodFunc?1:2;
        for(var i=start;i<argTypes.length;++i){
          var paramValue=i===1?thisWired:wiredArgs[i-2];
          if(argTypes[i].destructorFunction!==null){argTypes[i].destructorFunction(paramValue);}
        }
      }
      if(returns){return retType.fromWireType(rv);}
    };
  }`;

  return source.slice(0, startIdx) + replacement + source.slice(endIdx);
}

// A third dynamic-code-generation site: embind's __emval_get_method_caller()
// builds an invoker (used to call a *method on a JS object* from C++ code) the
// same way, via `new_(Function, params).apply(null, args)`. Replaced with a
// generic closure-based equivalent for the same reason as craftInvokerFunction.
function patchEmvalMethodCaller(source) {
  const startMarker = 'function __emval_get_method_caller(argCount,argTypes){';
  const endMarker = 'return __emval_addMethodCaller(invokerFunction)}';
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) return source; // nothing to patch (or already patched)
  const endIdx = source.indexOf(endMarker, startIdx) + endMarker.length;

  const replacement = `function __emval_get_method_caller(argCount,argTypes){
    var types=__emval_lookupTypes(argCount,argTypes);
    var retType=types[0];
    var expectedArgCount=argCount-1;
    var argTypesList=types.slice(1);
    var invokerFunction=function(handle,name,destructors,args){
      var argValues=new Array(expectedArgCount);
      var offset=0;
      for(var i=0;i<expectedArgCount;++i){
        argValues[i]=argTypesList[i].readValueFromPointer(args+offset);
        offset+=argTypesList[i]["argPackAdvance"];
      }
      var rv=handle[name].apply(handle,argValues);
      for(var i=0;i<expectedArgCount;++i){
        if(argTypesList[i]["deleteObject"]){argTypesList[i].deleteObject(argValues[i]);}
      }
      if(!retType.isVoid){return retType.toWireType(destructors,rv);}
    };
    return __emval_addMethodCaller(invokerFunction)}`;

  return source.slice(0, startIdx) + replacement + source.slice(endIdx);
}

// The worker's own catch blocks only forward `error.message` back to the main
// thread, discarding the stack trace — making it impossible to see *where* an
// error (e.g. a further, not-yet-found CSP violation) actually happened. This
// swaps every occurrence to prefer `error.stack` (falling back to `.message`),
// purely for diagnostics — it doesn't change control flow.
function addErrorStacks(source) {
  return source.split('error: error.message').join('error: (error && error.stack) || error.message');
}

function emitVoskWorkerPlugin() {
  return {
    name: 'emit-vosk-worker',
    closeBundle() {
      const voskBundlePath = resolve(__dirname, 'node_modules/vosk-browser/dist/vosk.js');
      const source = readFileSync(voskBundlePath, 'utf-8');

      const match = source.match(/createBase64WorkerFactory\('([^']+)'/);
      if (!match) {
        throw new Error(
          'emit-vosk-worker: could not find the embedded worker payload in ' +
            'vosk-browser/dist/vosk.js (its internal bundle format may have ' +
            'changed) — update the extraction logic in vite.config.js.'
        );
      }

      const decoded = Buffer.from(match[1], 'base64').toString('utf-8');
      // vosk-browser's own createURL() strips a leading header line the same
      // way before turning this into a Blob; mirror that here.
      const stripped = decoded.substring(decoded.indexOf('\n', 10) + 1);
      const body = addErrorStacks(patchEmvalMethodCaller(patchCraftInvokerFunction(patchOutEval(stripped))));

      const outDir = resolve(__dirname, 'dist/offscreen');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(resolve(outDir, 'vosk-worker.js'), body);
    },
  };
}

export default defineConfig({
  root: resolve(__dirname, 'src'),
  publicDir: resolve(__dirname, 'public'),
  plugins: [react(), copyPcmWorkletPlugin(), emitVoskWorkerPlugin()],
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/background.js'),
        offscreen: resolve(__dirname, 'src/offscreen/offscreen.html'),
        sidepanel: resolve(__dirname, 'src/sidepanel/sidepanel.html'),
      },
      output: {
        // Force the background service worker to a stable, predictable path
        // (referenced directly from manifest.json). Everything else (the
        // offscreen and side panel JS/CSS bundles, discovered automatically
        // from their HTML entry points) can use hashed asset names.
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') {
            return 'background/background.js';
          }
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
