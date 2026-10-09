import {useState} from 'react';
import {CODE_SAMPLE, CODE_TEMPLATES} from '@nodes';
import {Select} from './Select.tsx';
import {api} from './api.ts';
export function CodeConfig({config,onChange}:{config:Record<string,any>;onChange:(patch:Record<string,any>)=>void}) {
  const [busy,setBusy]=useState(false), [result,setResult]=useState<any>(null), [error,setError]=useState('');
  const language: 'javascript'|'python' = config.language === 'python'?'python':'javascript';
  const preset = (key:keyof typeof CODE_TEMPLATES) => {
    const input = key==='split'?JSON.stringify({items:[{id:1,amount:100},{id:2,amount:200}]},null,2):key==='chats'?JSON.stringify({chats:{'628111@c.us':{is_group:false,messages:[{text:'Order 2 produk'}]},'123@g.us':{is_group:true,messages:[{text:'Grup'}]}}},null,2):CODE_SAMPLE;
    onChange({code:CODE_TEMPLATES[key][language],inputJson:input,runMode:'all',title:CODE_TEMPLATES[key].label});setResult(null);setError('');
  };
  const test = async()=>{setBusy(true);setResult(null);setError('');try{const items=JSON.parse(config.inputJson || '[]');setResult(await api('POST','/api/code/test',{language,code:config.code,runMode:config.runMode ?? 'all',timeoutSeconds:config.timeoutSeconds ?? 10,items}));}catch(e:any){setError(e.message);}finally{setBusy(false);}};
  return <section className="code-config">
    <label>Nama node<input value={config.title ?? ''} placeholder="Contoh: Saring chat" onChange={e=>onChange({title:e.target.value})}/></label>
    <label>Bahasa<Select value={language} onChange={e=>{const next=e.target.value as 'javascript'|'python';onChange({language:next,code:config[next+'Code'] ?? CODE_TEMPLATES.passthrough[next],[language+'Code']:config.code});setResult(null);setError('');}}><option value="javascript">JavaScript</option><option value="python">Python</option></Select></label>
    <label>Mode eksekusi<Select value={config.runMode ?? 'all'} onChange={e=>onChange({runMode:e.target.value})}><option value="all">Sekali untuk semua item</option><option value="each">Sekali per item</option></Select></label>
    <label>Contoh kode<Select value="" placeholder="Pilih contoh untuk mengisi editor" onChange={e=>preset(e.target.value as keyof typeof CODE_TEMPLATES)}>{Object.entries(CODE_TEMPLATES).map(([key,t])=><option key={key} value={key}>{t.label}</option>)}</Select></label>
    <label>Kode {language === 'python'?'Python':'JavaScript'}<textarea className="code-editor" spellCheck={false} rows={16} value={config.code ?? CODE_TEMPLATES.passthrough[language]} onChange={e=>onChange({code:e.target.value,[language+'Code']:e.target.value})} onKeyDown={e=>{if(e.key==='Tab'){e.preventDefault();const target=e.currentTarget,a=target.selectionStart,b=target.selectionEnd;onChange({code:target.value.slice(0,a)+'    '+target.value.slice(b)});requestAnimationFrame(()=>target.setSelectionRange(a+4,a+4));}}}/></label>
    <p className="muted small">{language === 'javascript'?'$input.all(), $input.first().json, $json, $itemIndex':'_input.all(), _input.first()["json"], _json, _itemIndex'} tersedia. Gunakan return untuk mengembalikan objek atau daftar item {language === 'python' ? "{'json': {...}}" : '{json: {...}}'}. params berisi tanggal run, company_id, dan nama workflow.</p>
    <label>Batas waktu (detik)<input type="number" min={1} max={30} value={config.timeoutSeconds ?? 10} onChange={e=>onChange({timeoutSeconds:Number(e.target.value)})}/></label>
    <details open><summary>Input JSON & uji coba</summary>
      <p className="muted small">Saat disambung dari Start, JSON ini menjadi data awal. Webhook dapat menggantinya melalui items atau data. Jika ada data dari Code, respons HTTP, laporan, atau tabel di hulu, data tersebut yang dipakai.</p>
      <label>Input JSON<textarea className="code-editor" spellCheck={false} rows={8} value={config.inputJson ?? CODE_SAMPLE} onChange={e=>onChange({inputJson:e.target.value})}/></label>
      <label className="small">Baca file JSON<input type="file" accept=".json,application/json" onChange={async e=>{const file=e.target.files?.[0];if(!file)return;try{if(file.size>2*1024*1024)throw new Error('File maksimal 2 MB.');const text=await file.text();JSON.parse(text);onChange({inputJson:text});setError('');}catch(err:any){setError(err.message);}e.target.value='';}}/></label>
      <button className="btn primary" type="button" disabled={busy} onClick={test}>{busy?'Menjalankan…':'Uji kode tanpa LLM'}</button>
    </details>
    <p className="muted small">Hasil dapat disambung ke Code berikutnya, Parse Tabel, Export, Tulis Sheets, Kirim Pesan, atau HTTP. Runtime ini untuk transformasi JSON secara sinkron; akses file, jaringan, dan paket eksternal tidak tersedia. Python mendukung modul bawaan seperti json, re, math, datetime, collections, statistics, csv, dan decimal.</p>
    {error && <p className="notice" role="alert">{error}</p>}
    {result && <div className="code-result" aria-live="polite"><strong>{result.summary.items} item · 0 token LLM</strong><pre>{JSON.stringify(result.items.slice(0,100),null,2)}</pre>{result.items.length>100 && <p className="muted small">Pratinjau menampilkan 100 item pertama.</p>}{result.logs?.length>0 && <><strong>Log</strong><pre>{result.logs.join('\n')}</pre></>}</div>}
  </section>;
}
