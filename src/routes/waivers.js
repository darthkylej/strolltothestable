import { db } from '../lib/db.js';
import { json, error, requireUser, requireAdmin } from '../lib/util.js';
import { getSiteSettings } from '../lib/siteSettings.js';
import { createWaiverPdf } from '../lib/waiverPdf.js';
import { sendWaiverPdfEmail } from '../lib/email.js';
import { openEventDays } from '../lib/eventSchedule.js';
import { AGREEMENT_VERSION, DEFAULT_EVENT, agreementSections, RELEASE_ACK, CONSENT_TEXT } from '../lib/waiverText.js';

const key = n => `_waivers/${n.id}.json`;
const draftKey = n => `_waivers/${n.id}-draft.json`;
const reviewKey = n => `_waivers/${n.id}-review.json`;
const reviewPdfKey = n => `_waivers/${n.id}-review.pdf`;
async function sha256(bytes){const hash=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');}
const pdfKey = n => `_waivers/${n.id}.pdf`;
const paperKey = n => `_waivers/${n.id}-paper.json`;
export async function paperChoice(env,n){const o=await env.PHOTOS.get(paperKey(n));return o?JSON.parse(await o.text()):null;}
// Participant details as they are on the account right now. Blank values print
// as a line to fill in by hand on a paper waiver.
function ownerFields(n){return {name:String(n.owner_name||'').trim(),address:String(n.owner_address||'').trim(),cityStateZip:String(n.owner_city_state_zip||'').trim(),phone:String(n.owner_phone||'').trim(),email:String(n.owner_email||'').trim()};}
// A paper waiver set up by an admin (walk-in desk) has not been reviewed by the
// donor online, so it always prints the current account details. One the donor
// chose online keeps the details they reviewed.
function paperFields(n,paper){return n.paper_by_admin?ownerFields(n):paper.fields;}
// Printable copy for a donor who signs on paper, built from current data.
// `pre` may carry already-loaded { settings, pieces } to save lookups.
export async function paperPdf(env,n,paper,extra={},pre={}){const fields=paperFields(n,paper);const record=await waiverRecord(env,n,fields,{method:'paper',signerName:fields.name,signingDate:'',donorCode:n.owner_donor_code||'',...(n.paper_by_admin?{audit:paper.audit||{}}:{}),...extra},pre);return createWaiverPdf(record,null,'',await nativityPhoto(env,record));}
// Admin sets a pending submission to "sign on paper" (walk-ins, or a donor who
// arrives without having signed online).
export async function writeAdminPaperChoice(env,n,adminEmail){
  const now=new Date().toISOString();
  const paper={fields:ownerFields(n),requestedAt:now,audit:{requestedAt:now,enteredByAdmin:adminEmail,agreementVersion:AGREEMENT_VERSION}};
  await env.PHOTOS.put(paperKey(n),JSON.stringify(paper),{httpMetadata:{contentType:'application/json'}});
  return paper;
}
const formatDay = d => { const x = String(d || '').slice(0,10); return /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : ''; };
function eventDates(settings) {
  const drop = (settings.dropoffDays || []).filter(x => x.available !== false).map(x => formatDay(x.date)).filter(Boolean).sort();
  const pick = (settings.pickupDays || []).filter(x => x.available !== false).map(x => formatDay(x.date)).filter(Boolean).sort();
  const pickupDeadline = pick.at(-1) || formatDay(settings.pickupEnd);
  return {
    eventStart: openEventDays(settings)[0]?.date || formatDay(settings.eventStart) || DEFAULT_EVENT.start,
    eventEnd: openEventDays(settings).at(-1)?.date || formatDay(settings.eventEnd) || DEFAULT_EVENT.end,
    dropoffStart: drop[0] || formatDay(settings.dropoffStart),
    dropoffEnd: drop.at(-1) || formatDay(settings.dropoffEnd) || drop[0] || formatDay(settings.dropoffStart),
    pickupStart: pick[0] || formatDay(settings.pickupStart),
    // start/end kept for older records: overall drop-off through pick-up span.
    start: drop[0] || formatDay(settings.dropoffStart),
    end: pickupDeadline,
    pickupDeadline,
  };
}
async function owned(env, session, id, admin = false) {
  const sql = db(env);
  const rows = admin ? await sql`SELECT n.*,u.name AS owner_name,u.phone AS owner_phone,u.email AS owner_email,u.address AS owner_address,u.city_state_zip AS owner_city_state_zip,u.donor_code AS owner_donor_code FROM nativities n JOIN users u ON u.id=n.owner_user_id WHERE n.id=${id}` : await sql`SELECT n.*,u.name AS owner_name,u.phone AS owner_phone,u.email AS owner_email,u.address AS owner_address,u.city_state_zip AS owner_city_state_zip,u.donor_code AS owner_donor_code FROM nativities n JOIN users u ON u.id=n.owner_user_id WHERE n.id=${id} AND n.owner_user_id=${session.userId}`;
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
  const accountFields={name:n.owner_name,phone:n.owner_phone,email:n.owner_email};
  if(!prefill){const prior=await sql`SELECT id FROM nativities WHERE owner_user_id=${n.owner_user_id} AND id<>${n.id} ORDER BY created_at DESC LIMIT 20`;for(const row of prior){const previous=await env.PHOTOS.get(`_waivers/${row.id}.json`);if(previous){const w=JSON.parse(await previous.text());if(w.fields){prefill=w.fields;break;}}}}
  const pieces=await sql`SELECT piece_number,description,condition_notes FROM nativity_pieces WHERE nativity_id=${n.id} ORDER BY piece_number`;
  const submissions=[{submission_number:n.submission_number,story:n.story,piece_count:n.piece_count,pieces}];
  const settings=await getSiteSettings(env);
  const dates=eventDates(settings);
  const paper=existing?null:await paperChoice(env,n);
  // Name, phone and email always come from the account (edited on My Account).
  if(!existing) prefill={...(prefill||{}),...accountFields};
  return json({ waiver:existing, draft, signed:!!existing, paper:paper?{requestedAt:paper.requestedAt}:null, owner:{name:n.owner_name,phone:n.owner_phone,email:n.owner_email}, prefill, submissions, year:n.event_year, dates, organizer:'City of Seguin', agreement:{version:AGREEMENT_VERSION,sections:agreementSections(dates),releaseAck:RELEASE_ACK,consentText:CONSENT_TEXT} },{headers:{'Cache-Control':'no-store'}});
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
async function nativityPhoto(env,record) {
  const key=record.nativity?.photoKey||record.nativity?.displayPhotoKey;
  if(!key)return null;
  const object=await env.PHOTOS.get(key);
  return object?new Uint8Array(await object.arrayBuffer()):null;
}
async function waiverRecord(env,n,fields,extra={},pre={}) {
  const sql=db(env),settings=pre.settings||await getSiteSettings(env);
  const pieces=pre.pieces||await sql`SELECT piece_number,description,condition_notes,photo_key FROM nativity_pieces WHERE nativity_id=${n.id} ORDER BY piece_number`;
  const nativity={submissionNumber:n.submission_number,eventYear:n.event_year,description:n.description||'',story:n.story||'',pieceCount:n.piece_count,photoKey:n.photo_key||'',displayPhotoKey:n.display_photo_key||'',includeInTour:n.include_in_tour,pieces};
  return {version:5,agreementVersion:AGREEMENT_VERSION,nativity,year:n.event_year,organizer:'City of Seguin',event:'Stroll to the Stable',location:'Nolte Building, 101 E. Nolte St, Seguin, TX',dates:eventDates(settings),fields,method:'digital',submissionNumber:n.submission_number,...extra};
}
export async function previewWaiver(request,env,session,id) {
  requireUser(session);
  const n=await owned(env,session,id);
  if(n.submission_number.startsWith('DRAFT-')) return error('Finish the nativity submission first.',400);
  if(await saved(env,n)) return error('This waiver is already signed.',409);
  const body=await request.json();
  const f=body.fields||{};
  const fields={name:String(n.owner_name||'').trim(),address:String(f.address||'').trim(),cityStateZip:String(f.cityStateZip||'').trim(),phone:n.owner_phone,email:n.owner_email};
  if(['name','address','cityStateZip','phone','email'].some(k=>!fields[k])) return error('Complete all participant information before reviewing the PDF.',400);
  const record=await waiverRecord(env,n,fields,{signerName:'',signingDate:''});
  const pdf=await createWaiverPdf(record,null,'',await nativityPhoto(env,record));
  const hash=await sha256(pdf);
  const token=crypto.randomUUID();
  await env.PHOTOS.put(reviewPdfKey(n),pdf,{httpMetadata:{contentType:'application/pdf'}});
  await env.PHOTOS.put(reviewKey(n),JSON.stringify({token,hash,record,userId:session.userId,createdAt:new Date().toISOString()}),{httpMetadata:{contentType:'application/json'}});
  return new Response(pdf,{headers:{'Content-Type':'application/pdf','Content-Disposition':'inline; filename="Nativity-Waiver-Preview.pdf"','Cache-Control':'private, no-store','X-Waiver-Review-Token':token,'X-Waiver-Document-SHA256':hash,'Access-Control-Expose-Headers':'X-Waiver-Review-Token, X-Waiver-Document-SHA256'}});
}
export async function saveWaiver(request,env,session,id) {
  requireUser(session);
  const n=await owned(env,session,id);
  if(n.submission_number.startsWith('DRAFT-')) return error('Finish the nativity submission before completing the waiver.');
  const previous=await saved(env,n);
  if(previous) return error("This nativity's waiver is already signed.");
  const body=await request.json();
  if(!['digital','paper'].includes(body.method)) return error('Choose how to sign the waiver.');
  const f=body.fields || {};
  const fields={name:String(n.owner_name||'').trim(),address:String(f.address||'').trim(),cityStateZip:String(f.cityStateZip||'').trim(),phone:n.owner_phone,email:n.owner_email};
  if(['name','address','cityStateZip','phone','email'].some(k=>!fields[k])) return error('Complete all required waiver fields.');
  if(body.method==='digital' && body.releaseAccepted!==true) return error('Confirm that you have read and accept the Release of Liability.',400);
  if(body.method==='digital' && (!body.agreed || body.electronicSignatureConsent!==true || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(body.signatureImage||'') || (body.signatureImage||'').length>300000)) return error('Read the agreement and draw your signature.');
  const signerName=body.method==='paper'?fields.name:String(body.signerName||'').trim(), signingDate=body.method==='paper'?new Date().toISOString().slice(0,10):String(body.signingDate||'').trim();
  if(!signerName || !/^\d{4}-\d{2}-\d{2}$/.test(signingDate) || !Number.isFinite(Date.parse(signingDate+'T12:00:00Z'))) return error('Enter your printed name and signing date.',400);
  if(signerName.toLowerCase()!==fields.name.toLowerCase()) return error('Printed signing name must match the participant name.',400);
  const settings=await getSiteSettings(env);
  const dates=eventDates(settings);
  if(!dates.start || !dates.end || !dates.pickupDeadline) return error('Event dates must be configured before completing a waiver.');
  const sql=db(env);
  const reviewObject=await env.PHOTOS.get(reviewKey(n));
  if(!reviewObject) return error('Review the complete PDF before signing.',409);
  const review=JSON.parse(await reviewObject.text());
  if(review.userId!==session.userId || review.token!==body.reviewToken || review.hash!==body.reviewHash) return error('The reviewed document does not match. Review the PDF again.',409);
  const reviewedPdf=await env.PHOTOS.get(reviewPdfKey(n));
  if(!reviewedPdf || await sha256(await reviewedPdf.arrayBuffer())!==review.hash) return error('The reviewed PDF could not be verified. Review it again.',409);
  const current=await waiverRecord(env,n,fields,{signerName:'',signingDate:''});
  if(JSON.stringify(current)!==JSON.stringify(review.record)) return error('The waiver information changed. Review the updated PDF before signing.',409);
  const signedAt=new Date().toISOString();
  if(body.method==='paper') {
    if(await paperChoice(env,n)) return error('You already chose to sign a paper copy at drop-off.',409);
    const paper={fields,requestedAt:signedAt,audit:{requestedAt:signedAt,authenticatedUserId:session.userId,ipAddress:request.headers.get('CF-Connecting-IP')||null,userAgent:request.headers.get('User-Agent')||null,reviewedPdfSha256:review.hash,reviewedAt:review.createdAt,agreementVersion:AGREEMENT_VERSION}};
    await env.PHOTOS.put(paperKey(n),JSON.stringify(paper),{httpMetadata:{contentType:'application/json'}});
    await env.PHOTOS.delete(draftKey(n)); await env.PHOTOS.delete(reviewKey(n)); await env.PHOTOS.delete(reviewPdfKey(n));
    await sql`UPDATE nativities SET waiver_method='paper',paper_by_admin=NULL,updated_at=now() WHERE id=${n.id}`;
    let emailSent=false;
    try { await sendWaiverPdfEmail(env,{to:n.owner_email,name:n.owner_name,submissionNumber:n.submission_number,pdf:new Uint8Array(await paperPdf(env,n,paper)),settings,paper:true}); emailSent=true; }
    catch(e){ console.error('Paper waiver confirmation email failed:',e); }
    return json({ok:true,paper:true,emailSent});
  }
  const record={...review.record,signatureImage:body.signatureImage,signerName,signingDate,agreed:true,electronicSignatureConsent:true,releaseAccepted:true,completedAt:signedAt,
    audit:{signedAt,authenticatedUserId:session.userId,ipAddress:request.headers.get('CF-Connecting-IP')||null,userAgent:request.headers.get('User-Agent')||null,reviewToken:review.token,reviewedPdfSha256:review.hash,reviewedAt:review.createdAt,consentText:CONSENT_TEXT,releaseAcknowledgment:RELEASE_ACK,agreementVersion:AGREEMENT_VERSION}};
  if(body.method==='digital') {
    const pdf=await createWaiverPdf(record,null,'',await nativityPhoto(env,record));
    record.audit.signedPdfSha256=await sha256(pdf);
    await env.PHOTOS.put(pdfKey(n),pdf,{httpMetadata:{contentType:'application/pdf'}});
  }
  await env.PHOTOS.delete(draftKey(n));
  await env.PHOTOS.delete(reviewKey(n));
  await env.PHOTOS.delete(reviewPdfKey(n));
  await env.PHOTOS.delete(paperKey(n));
  await env.PHOTOS.put(key(n),JSON.stringify(record),{httpMetadata:{contentType:'application/json'}});
  if(body.method==='digital') { await sql`UPDATE nativities SET waiver_signed=true,waiver_signed_by='Digital signature',waiver_method='digital',paper_by_admin=NULL,waiver_signed_at=now(),updated_at=now() WHERE id=${n.id}`; }
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
  if(!(await saved(env,n))) {
    const paper=await paperChoice(env,n);
    if(!paper) return error('Signed waiver has not been received.',404);
    return new Response(await paperPdf(env,n,paper),{headers:{'Content-Type':'application/pdf','Content-Disposition':'inline; filename="Stroll-to-the-Stable-Waiver-'+n.submission_number.replace(/[^a-zA-Z0-9_-]/g,'')+'-to-sign.pdf"','Cache-Control':'private, no-store'}});
  }
  const rec=await saved(env,n);
  const object=await env.PHOTOS.get(rec?.batchPdfKey||pdfKey(n));
  if(!object) return error('Signed waiver PDF is not yet available.',404);
  return new Response(object.body,{headers:{'Content-Type':'application/pdf','Content-Disposition':'inline; filename="Stroll-to-the-Stable-Waiver-'+n.submission_number.replace(/[^a-zA-Z0-9_-]/g,'')+'.pdf"','Cache-Control':'private, no-store'}});
}

// Admin: the donor signed the printed copy at drop-off.
export async function markPaperSigned(request,env,session,id) {
  requireAdmin(session);
  const n=await owned(env,session,id,true);
  if(n.waiver_signed||await saved(env,n)) return error('This waiver is already signed.',409);
  const paper=await paperChoice(env,n);
  if(!paper) return error('This donor has not chosen to sign on paper.',400);
  await recordPaperSigned(env,n,paper,session.email);
  return json({ok:true});
}

async function recordPaperSigned(env,n,paper,adminEmail) {
  const session={email:adminEmail};
  const verifiedAt=new Date().toISOString();
  const extra={paperVerifiedBy:session.email,paperVerifiedAt:verifiedAt,completedAt:verifiedAt,audit:{...paper.audit,paperVerifiedBy:session.email,paperVerifiedAt:verifiedAt}};
  const fields=paperFields(n,paper);
  const record=await waiverRecord(env,n,fields,{method:'paper',signerName:fields.name,signingDate:'',donorCode:n.owner_donor_code||'',...extra});
  const pdf=await createWaiverPdf(record,null,'',await nativityPhoto(env,record));
  await env.PHOTOS.put(pdfKey(n),pdf,{httpMetadata:{contentType:'application/pdf'}});
  await env.PHOTOS.put(key(n),JSON.stringify(record),{httpMetadata:{contentType:'application/json'}});
  await env.PHOTOS.delete(paperKey(n));
  await db(env)`UPDATE nativities SET waiver_signed=true,waiver_method='paper',waiver_signed_by=${'Paper signature, verified by '+session.email},waiver_signed_at=now(),updated_at=now() WHERE id=${n.id}`;
}

// ── Walk-in desk batch waiver ────────────────────────────────────────────
// One agreement covers every nativity a walk-in donor brings in a visit. The
// combined PDF is stored once; each nativity's waiver record points to it.
const batchPdfKey = id => `_waivers/batch-${id}.pdf`;
const batchKey = id => `_waivers/batch-${id}.json`;

// Loads the donor's chosen pending nativities, in the order given.
async function loadBatch(env,donorId,ids) {
  const clean=[...new Set((Array.isArray(ids)?ids:[]).map(String).filter(v=>/^\d+$/.test(v)))].slice(0,200);
  if(!clean.length) throw error('Add at least one nativity first.',400);
  const arr=`{${clean.join(',')}}`;
  const rows=await db(env)`SELECT n.*,u.name AS owner_name,u.phone AS owner_phone,u.email AS owner_email,u.address AS owner_address,u.city_state_zip AS owner_city_state_zip,u.donor_code AS owner_donor_code
    FROM nativities n JOIN users u ON u.id=n.owner_user_id
    WHERE n.owner_user_id=${donorId} AND n.id = ANY(${arr}::bigint[])`;
  const byId=new Map(rows.map(r=>[String(r.id),r]));
  const list=clean.map(id=>byId.get(id)).filter(Boolean);
  if(list.length!==clean.length) throw error('One of these nativities was not found for this donor.',404);
  for(const n of list){
    if(n.submission_number.startsWith('DRAFT-')) throw error(n.submission_number+' is not finished yet.',400);
    if(n.status!=='pending') throw error(n.submission_number+' is already checked in.',409);
  }
  return list;
}

async function batchRecord(env,list,extra) {
  const n0=list[0];
  const settings=await getSiteSettings(env);
  const pieceRows=await db(env)`SELECT nativity_id, condition_notes FROM nativity_pieces WHERE nativity_id = ANY(${'{'+list.map(n=>n.id).join(',')+'}'}::bigint[]) AND piece_number=1`;
  const cond=new Map(pieceRows.map(p=>[String(p.nativity_id),p.condition_notes]));
  const nativities=list.map(n=>({id:String(n.id),submissionNumber:n.submission_number,description:n.description||'',pieceCount:n.piece_count,
    condition:/^No condition notes recorded/.test(cond.get(String(n.id))||'')?'':(cond.get(String(n.id))||''),photoKey:n.display_photo_key||n.photo_key||''}));
  return {version:5,agreementVersion:AGREEMENT_VERSION,batch:true,nativities,year:n0.event_year,organizer:'City of Seguin',event:'Stroll to the Stable',
    location:'Nolte Building, 101 E. Nolte St, Seguin, TX',dates:eventDates(settings),fields:ownerFields(n0),donorCode:n0.owner_donor_code||'',...extra};
}
async function batchPhotos(env,record){
  return Promise.all(record.nativities.map(async b=>{ if(!b.photoKey) return null; const o=await env.PHOTOS.get(b.photoKey); return o?new Uint8Array(await o.arrayBuffer()):null; }));
}

// GET /api/admin/donors/:id/batch-waiver-pdf?ids=1,2,3 — printable combined
// waiver for a paper signature.
export async function batchWaiverPdf(request,env,session,donorId) {
  requireAdmin(session);
  const ids=(new URL(request.url).searchParams.get('ids')||'').split(',');
  const list=(await loadBatch(env,donorId,ids)).filter(n=>!n.waiver_signed);
  if(!list.length) return error('These waivers are already signed.',409);
  const record=await batchRecord(env,list,{method:'paper',signerName:ownerFields(list[0]).name,signingDate:'',audit:{enteredByAdmin:session.email,requestedAt:new Date().toISOString()}});
  const pdf=await createWaiverPdf(record,null,'',await batchPhotos(env,record));
  return new Response(pdf,{headers:{'Content-Type':'application/pdf','Content-Disposition':'inline; filename="Stroll-to-the-Stable-Waiver-'+String(record.donorCode||'donor').replace(/[^a-zA-Z0-9_-]/g,'')+'.pdf"','Cache-Control':'private, no-store'}});
}

// POST /api/admin/donors/:id/desk-checkin { ids, method, checkIn, ... } — one
// waiver for the whole batch (donor signs once on the admin's device, or the
// admin confirms the printed batch waiver was signed), then every nativity in
// the batch is checked in. Nativities already signed online are just checked in.
// With checkIn:false (the check-in page) only the waiver is recorded; the admin
// still checks the pieces and finalizes each nativity.
export async function deskCheckInBatch(request,env,session,donorId) {
  requireAdmin(session);
  const body=await request.json().catch(()=>({}));
  const checkIn=body.checkIn!==false;
  const list=await loadBatch(env,donorId,body.ids);
  const noPhoto=list.filter(n=>!n.photo_key&&!n.display_photo_key);
  if(checkIn&&noPhoto.length) return error('Add a photo for '+noPhoto.map(n=>n.submission_number).join(', ')+' first.',400);
  if(!checkIn&&!list.some(n=>!n.waiver_signed)) return error('These waivers are already signed.',409);
  const toSign=list.filter(n=>!n.waiver_signed);
  for(const n of toSign) if(await saved(env,n)) return error(n.submission_number+' already has a signed waiver.',409);
  const sql=db(env);

  if(toSign.length){
    const name=ownerFields(toSign[0]).name;
    if(!name) return error('The donor needs a name before signing.',400);
    const at=new Date().toISOString(), batchId=crypto.randomUUID();
    let record, signedBy;
    if(body.method==='device'){
      if(body.releaseAccepted!==true||body.electronicSignatureConsent!==true) return error('The donor must check both boxes before signing.',400);
      if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(body.signatureImage||'')||(body.signatureImage||'').length>300000) return error('Have the donor sign in the box.',400);
      record=await batchRecord(env,toSign,{method:'digital',signerName:name,signingDate:new Date().toLocaleDateString('en-CA',{timeZone:'America/Chicago'}),signatureImage:body.signatureImage,
        agreed:true,electronicSignatureConsent:true,releaseAccepted:true,completedAt:at,batchId,
        audit:{signedAt:at,signedInPersonOnAdminDevice:true,enteredByAdmin:session.email,ipAddress:request.headers.get('CF-Connecting-IP')||null,userAgent:request.headers.get('User-Agent')||null,consentText:CONSENT_TEXT,releaseAcknowledgment:RELEASE_ACK,agreementVersion:AGREEMENT_VERSION}});
      signedBy='Digital signature on admin device ('+session.email+'), batch waiver';
    } else if(body.method==='paper'){
      record=await batchRecord(env,toSign,{method:'paper',signerName:name,signingDate:'',paperVerifiedBy:session.email,paperVerifiedAt:at,completedAt:at,batchId,
        audit:{enteredByAdmin:session.email,paperVerifiedBy:session.email,paperVerifiedAt:at,agreementVersion:AGREEMENT_VERSION}});
      signedBy='Paper signature, verified by '+session.email+', batch waiver';
    } else return error('Choose how the waiver was signed.',400);

    const pdf=await createWaiverPdf(record,null,'',await batchPhotos(env,record));
    if(record.audit) record.audit.signedPdfSha256=await sha256(pdf);
    await env.PHOTOS.put(batchPdfKey(batchId),pdf,{httpMetadata:{contentType:'application/pdf'}});
    await env.PHOTOS.put(batchKey(batchId),JSON.stringify(record),{httpMetadata:{contentType:'application/json'}});
    const method=record.method;
    for(const n of toSign){
      const own={...record,signatureImage:undefined,submissionNumber:n.submission_number,batchPdfKey:batchPdfKey(batchId),batchSize:toSign.length};
      await env.PHOTOS.put(key(n),JSON.stringify(own),{httpMetadata:{contentType:'application/json'}});
      for(const k of [paperKey(n),draftKey(n),reviewKey(n),reviewPdfKey(n)]) await env.PHOTOS.delete(k);
    }
    const arr='{'+toSign.map(n=>n.id).join(',')+'}';
    await sql`UPDATE nativities SET waiver_signed=true,waiver_method=${method},paper_by_admin=NULL,waiver_signed_by=${signedBy},waiver_signed_at=now(),updated_at=now() WHERE id = ANY(${arr}::bigint[])`;
  }

  if(!checkIn) return json({ok:true,signed:toSign.map(n=>({id:String(n.id),submissionNumber:n.submission_number}))});
  const all='{'+list.map(n=>n.id).join(',')+'}';
  const done=await sql`UPDATE nativities SET status='submitted',finalized_by=${session.email},finalized_at=now(),updated_at=now()
    WHERE id = ANY(${all}::bigint[]) AND status='pending' AND waiver_signed RETURNING id, submission_number`;
  return json({ok:true,checkedIn:done.map(r=>({id:String(r.id),submissionNumber:r.submission_number})),donorCode:list[0].owner_donor_code||null});
}

// Walk-in desk: record the waiver and check the nativity in, in one step.
// body.method: 'device' = the donor signs on the admin's phone or tablet,
// 'paper' = the donor signed the printed copy. A waiver that is already signed
// (for example, signed online) just gets checked in.
// No piece-by-piece check: the admin entered the nativity themselves.
export async function deskCheckIn(request,env,session,id) {
  requireAdmin(session);
  const n=await owned(env,session,id,true);
  if(n.submission_number.startsWith('DRAFT-')) return error('This submission is not finished yet.',400);
  if(n.status!=='pending') return error('This nativity is already checked in.',409);
  if(!n.photo_key&&!n.display_photo_key) return error('Add a photo of the nativity first.',400);
  const body=await request.json().catch(()=>({}));
  const sql=db(env);

  if(!n.waiver_signed) {
    if(await saved(env,n)) return error('This waiver is already signed.',409);
    if(body.method==='device') {
      if(body.releaseAccepted!==true||body.electronicSignatureConsent!==true) return error('The donor must check both boxes before signing.',400);
      if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(body.signatureImage||'')||(body.signatureImage||'').length>300000) return error('Have the donor sign in the box.',400);
      const fields=ownerFields(n);
      if(!fields.name) return error('The donor needs a name before signing.',400);
      const signedAt=new Date().toISOString();
      const signingDate=new Date().toLocaleDateString('en-CA',{timeZone:'America/Chicago'});
      const record=await waiverRecord(env,n,fields,{signerName:fields.name,signingDate,donorCode:n.owner_donor_code||'',signatureImage:body.signatureImage,agreed:true,electronicSignatureConsent:true,releaseAccepted:true,completedAt:signedAt,
        audit:{signedAt,signedInPersonOnAdminDevice:true,enteredByAdmin:session.email,ipAddress:request.headers.get('CF-Connecting-IP')||null,userAgent:request.headers.get('User-Agent')||null,consentText:CONSENT_TEXT,releaseAcknowledgment:RELEASE_ACK,agreementVersion:AGREEMENT_VERSION}});
      const pdf=await createWaiverPdf(record,null,'',await nativityPhoto(env,record));
      record.audit.signedPdfSha256=await sha256(pdf);
      await env.PHOTOS.put(pdfKey(n),pdf,{httpMetadata:{contentType:'application/pdf'}});
      await env.PHOTOS.put(key(n),JSON.stringify(record),{httpMetadata:{contentType:'application/json'}});
      for(const k of [paperKey(n),draftKey(n),reviewKey(n),reviewPdfKey(n)]) await env.PHOTOS.delete(k);
      await sql`UPDATE nativities SET waiver_signed=true,waiver_method='digital',paper_by_admin=NULL,waiver_signed_by=${'Digital signature on admin device ('+session.email+')'},waiver_signed_at=now(),updated_at=now() WHERE id=${n.id}`;
    } else if(body.method==='paper') {
      let paper=await paperChoice(env,n);
      if(!paper) {
        paper=await writeAdminPaperChoice(env,n,session.email);
        await sql`UPDATE nativities SET waiver_method='paper',paper_by_admin=${session.email},updated_at=now() WHERE id=${n.id}`;
        n.paper_by_admin=session.email;
      }
      await recordPaperSigned(env,n,paper,session.email);
    } else {
      return error('Choose how the waiver was signed.',400);
    }
  }

  const done=await sql`
    UPDATE nativities SET status='submitted',finalized_by=${session.email},finalized_at=now(),updated_at=now()
    WHERE id=${n.id} AND status='pending' RETURNING id`;
  if(!done.length) return error('This nativity is already checked in.',409);
  return json({ok:true,id:n.id,submissionNumber:n.submission_number,donorCode:n.owner_donor_code||null});
}

// Admin: switch a pending, unsigned submission to a paper waiver signed at the
// desk. Used for walk-ins and for donors who arrive without signing online.
export async function adminChoosePaper(request,env,session,id) {
  requireAdmin(session);
  const n=await owned(env,session,id,true);
  if(n.submission_number.startsWith('DRAFT-')) return error('This submission is not finished yet.',400);
  if(n.status!=='pending') return error('This nativity is already checked in.',409);
  if(n.waiver_signed||await saved(env,n)) return error('This waiver is already signed.',409);
  await writeAdminPaperChoice(env,n,session.email);
  await env.PHOTOS.delete(draftKey(n)); await env.PHOTOS.delete(reviewKey(n)); await env.PHOTOS.delete(reviewPdfKey(n));
  await db(env)`UPDATE nativities SET waiver_method='paper',paper_by_admin=${session.email},updated_at=now() WHERE id=${n.id}`;
  return json({ok:true});
}

// Clears the waiver after the donor edits a submission, returning it to the
// "Sign Waiver" step. A signed waiver is moved to an archive (not shown to
// anyone) rather than destroyed, so there is a record of what was signed.
export async function resetWaiver(env, n) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const [src, ext] of [[key(n), 'json'], [pdfKey(n), 'pdf']]) {
    const obj = await env.PHOTOS.get(src);
    if (obj) {
      await env.PHOTOS.put(`_waivers/archive/${n.id}-${stamp}.${ext}`, await obj.arrayBuffer(), { httpMetadata: { contentType: ext === 'pdf' ? 'application/pdf' : 'application/json' } });
      await env.PHOTOS.delete(src);
    }
  }
  await Promise.all([paperKey(n), reviewKey(n), reviewPdfKey(n)].map((k) => env.PHOTOS.delete(k)));
  await db(env)`UPDATE nativities SET waiver_signed=false, waiver_method=NULL, paper_by_admin=NULL, waiver_signed_by=NULL, waiver_signed_at=NULL, updated_at=now() WHERE id=${n.id}`;
}

// Clears the waivers of all of a donor's submissions that are not checked in
// yet (used when the donor's name, phone or email changes). Checked-in
// submissions keep the waiver they were checked in with.
export async function resetWaiversForUser(env, userId) {
  const rows = await db(env)`
    SELECT n.*, u.name AS owner_name, u.phone AS owner_phone, u.email AS owner_email
    FROM nativities n JOIN users u ON u.id = n.owner_user_id
    WHERE n.owner_user_id = ${userId} AND n.status = 'pending'
      AND (n.waiver_signed OR n.waiver_method IS NOT NULL)
      -- An unsigned paper waiver set up by an admin prints the current
      -- account details, so there is nothing to clear.
      AND NOT (n.paper_by_admin IS NOT NULL AND NOT n.waiver_signed)`;
  for (const n of rows) await resetWaiver(env, n);
  return rows.length;
}
