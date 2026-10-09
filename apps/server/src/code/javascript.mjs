import { getQuickJS } from 'quickjs-emscripten';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);
const engine = await getQuickJS();
const runtime = engine.newRuntime();
runtime.setMemoryLimit(64 * 1024 * 1024);
runtime.setMaxStackSize(512 * 1024);
const deadline = Date.now() + request.timeout * 1000;
runtime.setInterruptHandler(() => Date.now() > deadline);
const context = runtime.newContext();
try {
  // Only JSON crosses the WASM boundary; no Node objects, modules, filesystem or network bindings.
  const source = `(() => {
    const items = ${JSON.stringify(request.items)};
    const params = ${JSON.stringify(request.params ?? {})};
    const logs = [];
    const console = {log: (...v) => {if(logs.length<50) logs.push(v.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' ').slice(0,2000));}};
    console.warn = console.error = console.log;
    const execute = (batch,index) => {
      const $input = {all:()=>batch,first:()=>batch[0],last:()=>batch[batch.length-1],item:batch[0]};
      const $json = $input.item?.json ?? {};
      const $itemIndex = index ?? 0;
      const result = (function() {${request.code}\n})();
      if(result && typeof result.then==='function') throw new Error('Gunakan kode sinkron untuk transformasi data.');
      return result;
    };
    const output = ${request.mode === 'each' ? 'items.flatMap((item,i)=>{const out=execute([item],i);return out==null?[]:Array.isArray(out)?out:[out];})' : 'execute(items)'};
    if(output && typeof output.then==='function') throw new Error('Gunakan kode sinkron untuk transformasi data.');
    return JSON.stringify({output,logs});
  })()`;
  const result = context.evalCode(source, 'user-code.js');
  if (result.error) {
    const error = context.dump(result.error);
    result.error.dispose();
    throw new Error(`${error.name ?? 'Error'}: ${error.message ?? error}`);
  }
  const output = context.getString(result.value);
  result.value.dispose();
  process.stdout.write(output);
} catch (error) {
  process.stdout.write(JSON.stringify({error:String(error.message ?? error)}));
  process.exitCode = 1;
} finally {context.dispose();runtime.dispose();}
