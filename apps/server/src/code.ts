import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { MdTable } from '../../../packages/engine/src/table.ts';
export interface CodeItem { json: Record<string, any> }
export const MAX_CODE_BYTES = 2 * 1024 * 1024;
export function codeItems(value: unknown): CodeItem[] {
  const array = value == null ? [] : Array.isArray(value) ? value : [value];
  if (array.length > 10000) throw new Error('Code: maksimal 10.000 item per langkah.');
  return array.map(item => {
    const json = item && typeof item === 'object' && !Array.isArray(item) ? (Object.hasOwn(item,'json') ? item.json : item) : {value:item};
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('Code: setiap item.json harus berupa objek JSON.');
    return {json};
  });
}
export async function executeCode(config: Record<string, any>, items: unknown, params: Record<string, any> = {}) {
  const language = config.language ?? 'javascript';
  if (!['javascript','python'].includes(language)) throw new Error('Pilih bahasa Python atau JavaScript.');
  if (!String(config.code ?? '').trim() || String(config.code).length > 100000) throw new Error('Isi kode (maksimal 100.000 karakter).');
  const timeout = Math.max(1,Math.min(30,Number(config.timeoutSeconds)||10));
  const mode = config.runMode ?? 'all';
  if (!['all','each'].includes(mode)) throw new Error('Pilih mode semua item atau per item.');
  const input = JSON.stringify({code:config.code,items:codeItems(items),params,timeout,mode});
  if (Buffer.byteLength(input) > MAX_CODE_BYTES) throw new Error('Code: input maksimal 2 MB.');
  const script = fileURLToPath(new URL(language === 'python' ? './code/python.py' : './code/javascript.mjs',import.meta.url));
  const result = await new Promise<any>((resolve,reject) => {
    const child = spawn(language === 'python' ? 'python3' : process.execPath, language === 'python' ? ['-I','-B',script] : ['--max-old-space-size=128',script], {env:{},stdio:['pipe','pipe','pipe']});
    let out = '', error = '', bytes = 0, failed = false;
    const fail = (message: string) => {if(!failed){failed=true;child.kill('SIGKILL');reject(new Error(message));}};
    const timer = setTimeout(()=>fail(`Code dihentikan: melewati batas ${timeout} detik.`),(timeout+2)*1000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>MAX_CODE_BYTES)fail('Code: output maksimal 2 MB.');else out+=chunk.toString();});
    child.stderr.on('data',chunk=>{error=(error+chunk.toString()).slice(0,2000);});
    child.on('error',err=>{clearTimeout(timer);fail(`Runtime ${language} tidak tersedia: ${err.message}`);});
    child.on('close',()=>{clearTimeout(timer);if(failed)return;try{const value=JSON.parse(out);if(value.error)reject(new Error(value.error));else if(!Object.hasOwn(value,'output'))reject(new Error('Kode harus mengembalikan output dengan return.'));else resolve(value);}catch{reject(new Error(error || 'Code gagal atau melewati batas memori.'));}});
    child.stdin.on('error',()=>{});
    child.stdin.end(input);
  });
  return {...dataOutput(result.output,String(config.title || 'Hasil Code')),logs:result.logs ?? [],summary:{kind:'code',language,mode,input:codeItems(items).length,items:codeItems(result.output).length,rows:codeItems(result.output).length,tokens:0}};
}
export function dataOutput(value: unknown, title = 'Data JSON') {
  const output = codeItems(value);
  const columns = [...new Set(output.flatMap(item=>Object.keys(item.json)))];
  if (columns.length > 200 || columns.length * output.length > 1000000) throw new Error('Data JSON: tabel output maksimal 200 kolom dan 1.000.000 sel. Pilih kolom yang diperlukan.');
  const cell = (value: any) => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const tables: MdTable[] = columns.length ? [{columns,rows:output.map(item=>columns.map(key=>cell(item.json[key])))}] : [];
  const content = output.map(item=>typeof item.json.content==='string'?item.json.content:JSON.stringify(item.json,null,2)).join('\n\n');
  return {items:output,tables,report:{label:title,content}};
}
