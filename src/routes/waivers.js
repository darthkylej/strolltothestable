import { db } from '../lib/db.js';
import { json, error, requireUser, requireAdmin } from '../lib/util.js';
import { getSiteSettings } from '../lib/siteSettings.js';
import { createWaiverPdf } from '../lib/waiverPdf.js';
import { sendWaiverPdfEmail } from '../lib/email.js';

const key = n => `_waivers/${n.id}.json`;
const draftKey = n => `_waivers/${n.id}-draft.json`;
const pdfKey = n => `_waivers/${n.id}.pdf`;
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
async function saved(env,n) { const obj=await env.PHOTOS.get(key(n)); return obj ? JSON.parse(await obj.text()) : null; }
export async function getWaiver(request,env,session,id) {
  if (session?.kind === 'admin') requireAdmin(session); else requireUser(session);
  const n=await owned(env,session,id,session.kind==='admin');
  const existing=await saved(env,n);
  const sql=db(env);
  const draftObj=existing?null:await env.PHOTOS.get(draftKey(n));
  const draft=draftObj?JSON.parse(await draftObj.text()):null;
  let prefill=existing?.fields||draft?.fields||null;
  if(!prefill){const prior=await sql`SELECT id FROM nativities WHERE owner_user_id=${n.owner_user_id} AND id<>${n.id} ORDER BY created_at DESC LIMIT 20`;for(const row of prior){const previous=await env.PHOTOS.get(`_waivers/${row.id}.json`);if(previous){const w=JSON.parse(await previous.text());if(w.fields){prefill=w.fields;break;}}}}
  const pieces=await sql`SELECT piece_number,description,condition_notes FROM nativity_pieces WHERE nativity_id=${n.id} ORDER BY piece_number`;
  const submissions=[{submission_number:n.submission_number,story:n.story,piece_count:n.piece_count,pieces}];
  const settings=await getSiteSettings(env);
  return json({ waiver:existing, draft, signed:!!existing, owner:{name:n.owner_name,phone:n.owner_phone,email:n.owner_email}, prefill, submissions, year:n.event_year, dates:eventDates(settings), organizer:'City of Seguin' },{headers:{'Cache-Control':'no-store'}});
}
export async function saveWaiverDraft(request,env,session,id) {
  requireUser(session);
  const n=await owned(env,session,id);
  if(await saved(env,n)) return error('This waiver is already signed.',409);
  const body=await request.json();
  const fields={};
  for(const k of ['name','address','cityStateZip','phone','email']) fields[k]=String(body.fields?.[k]||'').slice(0,500);
  await env.PHOTOS.put(draftKey(n),JSON.stringify({fields,updatedAt:new Date().toISOString()}),{httpMetadata:{contentType:'application/json'}});
  return json({ok:true});
}
async function waiverRecord(env,n,fields,extra={}) {
  const sql=db(env),settings=await getSiteSettings(env);
  const pieces=await sql`SELECT piece_number,description,condition_notes,photo_key FROM nativity_pieces WHERE nativity_id=${n.id} ORDER BY piece_number`;
  const nativity={submissionNumber:n.submission_number,eventYear:n.event_year,story:n.story||'',pieceCount:n.piece_count,photoKey:n.photo_key||'',displayPhotoKey:n.display_photo_key||'',includeInTour:n.include_in_tour,pieces};
  return {version:4,nativity,year:n.event_year,organizer:'City of Seguin',event:'Stroll to the Stable',location:'Nolte Building, 101 E. Nolte St, Seguin, TX',dates:eventDates(settings),fields,method:'digital',submissionNumber:n.submission_number,...extra};
}
export async function previewWaiver(request,env,session,id) {
  requireUser(session);
  const n=await owned(env,session,id);
  if(n.submission_number.startsWith('DRAFT-')) return error('Finish the nativity submission first.',400);
  if(await saved(env,n)) return error('This waiver is already signed.',409);
  const body=await request.json();
  const f=body.fields||{};
  const fields={name:String(f.name||'').trim(),address:String(f.address||'').trim(),cityStateZip:String(f.cityStateZip||'').trim(),phone:n.owner_phone,email:n.owner_email};
  if(['name','address','cityStateZip','phone','email'].some(k=>!fields[k])) return error('Complete all participant information before reviewing the PDF.',400);
  const record=await waiverRecord(env,n,fields,{signerName:'',signingDate:''});
  const pdf=await createWaiverPdf(record);
  return new Response(pdf,{headers:{'Content-Type':'application/pdf','Content-Disposition':'inline; filename="Nativity-Waiver-Preview.pdf"','Cache-Control':'private, no-store'}});
}
export async function saveWaiver(request,env,session,id) {
  requireUser(session);
  const n=await owned(env,session,id);
  if(n.submission_number.startsWith('DRAFT-')) return error('Finish the nativity submission before completing the waiver.');
  const previous=await saved(env,n);
  if(previous) return error("This nativity's waiver is already signed.");
  const body=await request.json();
  if(body.method!=='digital') return error('Digital signing is required.');
  const f=body.fields || {};
  const fields={name:String(f.name||'').trim(),address:String(f.address||'').trim(),cityStateZip:String(f.cityStateZip||'').trim(),phone:n.owner_phone,email:n.owner_email};
  if(['name','address','cityStateZip','phone','email'].some(k=>!fields[k])) return error('Complete all required waiver fields.');
  if(body.method==='digital' && (!body.agreed || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(body.signatureImage||'') || (body.signatureImage||'').length>300000)) return error('Read the agreement and draw your signature.');
  const signerName=String(body.signerName||'').trim(), signingDate=String(body.signingDate||'').trim();
  if(!signerName || !/^\\d{4}-\\d{2}-\\d{2}$/.test(signingDate) || !Number.isFinite(Date.parse(signingDate+'T12:00:00Z'))) return error('Enter your printed name and signing date.',400);
  if(signerName.toLowerCase()!==fields.name.toLowerCase()) return error('Printed signing name must match the participant name.',400);
  const settings=await getSiteSettings(env);
  const dates=eventDates(settings);
  if(!dates.start || !dates.end || !dates.pickupDeadline) return error('Event dates must be configured before completing a waiver.');
  const sql=db(env);
  const record=await waiverRecord(env,n,fields,{signatureImage:body.signatureImage,signerName,signingDate,agreed:true,completedAt:new Date().toISOString()});
  if(body.method==='digital') {
    const pdf=await createWaiverPdf(record);
    await env.PHOTOS.put(pdfKey(n),pdf,{httpMetadata:{contentType:'application/pdf'}});
  }
  await env.PHOTOS.delete(draftKey(n));
  await env.PHOTOS.put(key(n),JSON.stringify(record),{httpMetadata:{contentType:'application/json'}});
  if(body.method==='digital') { await sql`UPDATE nativities SET waiver_signed=true,waiver_signed_by='Digital signature',waiver_signed_at=now(),updated_at=now() WHERE id=${n.id}`; }
  let emailSent = null;
  if(body.method==='digital') {
    const pdfObject=await env.PHOTOS.get(pdfKey(n));
    try {
      await sendWaiverPdfEmail(env,{to:n.owner_email,name:n.owner_name,submissionNumber:n.submission_number,pdf:new Uint8Array(await pdfObject.arrayBuffer()),settings});
      emailSent=true;
    } catch(e) { emailSent=false; console.error('Signed waiver PDF email failed:',e); }
  }
  return json({ok:true,waiver:record,emailSent});
}

export async function downloadWaiverPdf(request,env,session,id) {
  if(session?.kind==='admin') requireAdmin(session); else requireUser(session);
  const n=await owned(env,session,id,session.kind==='admin');
  if(!(await saved(env,n))) return error('Signed waiver has not been received.',404);
  const object=await env.PHOTOS.get(pdfKey(n));
  if(!object) return error('Signed waiver PDF is not yet available.',404);
  return new Response(object.body,{headers:{'Content-Type':'application/pdf','Content-Disposition':'inline; filename="Stroll-to-the-Stable-Waiver-'+n.submission_number.replace(/[^a-zA-Z0-9_-]/g,'')+'.pdf"','Cache-Control':'private, no-store'}});
}
