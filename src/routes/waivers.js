import { db } from '../lib/db.js';
import { json, error, requireUser, requireAdmin } from '../lib/util.js';
import { getSiteSettings } from '../lib/siteSettings.js';
import { createWaiverPdf } from '../lib/waiverPdf.js';
import { sendWaiverPdfEmail } from '../lib/email.js';

const key = id => `_waivers/${id}.json`;
const formatDay = d => { const x = String(d || '').slice(0,10); return /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : ''; };
function eventDates(settings) {
  const drop = (settings.dropoffDays || []).filter(x => x.available !== false).map(x => formatDay(x.date)).filter(Boolean).sort();
  const pick = (settings.pickupDays || []).filter(x => x.available !== false).map(x => formatDay(x.date)).filter(Boolean).sort();
  return { start: drop[0] || formatDay(settings.dropoffStart), end: pick.at(-1) || formatDay(settings.pickupEnd), pickupDeadline: pick.at(-1) || formatDay(settings.pickupEnd) };
}
async function owned(env, session, id, admin = false) {
  const sql = db(env);
  const rows = admin ? await sql`SELECT n.*,u.name AS owner_name,u.phone AS owner_phone,u.email AS owner_email FROM nativities n JOIN users u ON u.id=n.owner_user_id WHERE n.id=${id}` : await sql`SELECT n.*,u.name AS owner_name,u.phone AS owner_phone,u.email AS owner_email FROM nativities n JOIN users u ON u.id=n.owner_user_id WHERE n.id=${id} AND n.owner_user_id=${session.userId}`;
  if (!rows.length) throw error('Nativity not found.',404);
  return rows[0];
}
async function saved(env,id) { const obj=await env.PHOTOS.get(key(id)); return obj ? JSON.parse(await obj.text()) : null; }
export async function getWaiver(request,env,session,id) {
  if (session?.kind === 'admin') requireAdmin(session); else requireUser(session);
  const n=await owned(env,session,id,session.kind==='admin');
  const existing=await saved(env,id);
  const sql=db(env);
  const prior= session.kind==='admin' ? [] : await sql`SELECT n.id FROM nativities n WHERE n.owner_user_id=${session.userId} AND n.id != ${id} ORDER BY n.created_at DESC LIMIT 30`;
  let prefill=null;
  for(const row of prior) { const w=await saved(env,row.id); if(w?.fields) {prefill=w.fields;break;} }
  const pieces=await sql`SELECT description FROM nativity_pieces WHERE nativity_id=${id} ORDER BY piece_number`;
  const settings=await getSiteSettings(env);
  return json({ waiver:existing, signed:!!n.waiver_signed, owner:{name:n.owner_name,phone:n.owner_phone,email:n.owner_email}, prefill, pieceCount:n.piece_count, description:pieces.map(p=>p.description).join(', '), story:n.story || '', dates:eventDates(settings), organizer:'City of Seguin' },{headers:{'Cache-Control':'no-store'}});
}
export async function saveWaiver(request,env,session,id) {
  requireUser(session);
  const n=await owned(env,session,id);
  if(n.submission_number.startsWith('DRAFT-')) return error('Finish the nativity submission before completing the waiver.');
  const previous=await saved(env,id);
  if(n.waiver_signed) return error('This waiver has already been received and cannot be changed.');
  const body=await request.json();
  if(!['digital','print','onsite'].includes(body.method)) return error('Choose a waiver method.');
  const f=body.fields || {};
  const fields={name:String(f.name||'').trim(),address:String(f.address||'').trim(),cityStateZip:String(f.cityStateZip||'').trim(),phone:String(f.phone||'').trim(),email:String(f.email||'').trim(),title:String(f.title||'').trim(),story:String(f.story||'').trim(),dimensions:String(f.dimensions||'').trim(),pieces:String(f.pieces||'').trim(),materials:String(f.materials||'').trim(),fragile:String(f.fragile||'').trim()};
  if(body.method!=='onsite' && ['name','address','cityStateZip','phone','email','title','dimensions','pieces','materials','fragile'].some(k=>!fields[k])) return error('Complete all required waiver fields.');
  if(body.method==='digital' && (!body.agreed || !body.initials?.trim() || !body.signature?.trim())) return error('Read the agreement, initial the donation clause, and sign.');
  const settings=await getSiteSettings(env);
  const dates=eventDates(settings);
  if(body.method!=='onsite' && (!dates.start || !dates.end || !dates.pickupDeadline)) return error('Event dates must be configured before completing a waiver.');
  const record={version:1,organizer:'City of Seguin',event:'Stroll to the Stable',location:'Nolte Building, 101 E. Nolte St, Seguin, TX',dates,fields,method:body.method,initials:body.method==='digital'?String(body.initials).trim():null,signature:body.method==='digital'?String(body.signature).trim():null,agreed:body.method==='digital',completedAt:new Date().toISOString(),submissionNumber:n.submission_number};
  if(body.method==='digital') {
    const pdf=await createWaiverPdf(record);
    await env.PHOTOS.put(`_waivers/${id}.pdf`,pdf,{httpMetadata:{contentType:'application/pdf'}});
  }
  await env.PHOTOS.put(key(id),JSON.stringify(record),{httpMetadata:{contentType:'application/json'}});
  if(body.method==='digital') { const sql=db(env); await sql`UPDATE nativities SET waiver_signed=true,waiver_signed_by='Digital signature',waiver_signed_at=now(),updated_at=now() WHERE id=${id}`; }
  let emailSent = null;
  if(body.method==='digital') {
    const pdfObject=await env.PHOTOS.get(`_waivers/${id}.pdf`);
    try {
      await sendWaiverPdfEmail(env,{to:n.owner_email,name:n.owner_name,submissionNumber:n.submission_number,pdf:new Uint8Array(await pdfObject.arrayBuffer())});
      emailSent=true;
    } catch(e) { emailSent=false; console.error('Signed waiver PDF email failed:',e); }
  }
  return json({ok:true,waiver:record,emailSent});
}

export async function downloadWaiverPdf(request,env,session,id) {
  if(session?.kind==='admin') requireAdmin(session); else requireUser(session);
  const n=await owned(env,session,id,session.kind==='admin');
  if(!n.waiver_signed) return error('Signed waiver has not been received.',404);
  const object=await env.PHOTOS.get(`_waivers/${id}.pdf`);
  if(!object) return error('Signed waiver PDF is not yet available.',404);
  return new Response(object.body,{headers:{'Content-Type':'application/pdf','Content-Disposition':'inline; filename="Stroll-to-the-Stable-Waiver-'+n.submission_number.replace(/[^a-zA-Z0-9_-]/g,'')+'.pdf"','Cache-Control':'private, no-store'}});
}
export async function uploadSignedWaiver(request,env,session,id) {
  requireAdmin(session);
  const n=await owned(env,session,id,true);
  if(n.waiver_signed) return error('This signed waiver has already been received and cannot be replaced.');
  const file=(await request.formData()).get('file');
  if(!(file instanceof File) || !['image/jpeg','image/png','application/pdf'].includes(file.type) || file.size>10*1024*1024) return error('Upload a PDF, JPEG or PNG under 10 MB.');
  const bytes=new Uint8Array(await file.arrayBuffer());
  const record=await saved(env,id);
  if(!record) return error('Complete the waiver form before uploading its signed copy.');
  if(record.method==='digital') return error('A digitally signed PDF cannot be replaced.');
  const pdf=file.type==='application/pdf'?bytes:await createWaiverPdf(record,bytes,file.type);
  await env.PHOTOS.put(`_waivers/${id}.pdf`,pdf,{httpMetadata:{contentType:'application/pdf'}});
  const sql=db(env);
  await sql`UPDATE nativities SET waiver_signed=true,waiver_signed_by=${session.email},waiver_signed_at=now(),updated_at=now() WHERE id=${id}`;
  try{await sendWaiverPdfEmail(env,{to:n.owner_email,name:n.owner_name,submissionNumber:n.submission_number,pdf});}
  catch(e){console.error('Signed waiver PDF email failed:',e);}
  return json({ok:true});
}
