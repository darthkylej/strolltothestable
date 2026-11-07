import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const labels = [
 ['name','Name'],['address','Address'],['cityStateZip','City/State/ZIP'],['phone','Phone'],['email','Email'],
 ['title','Title or Description of Nativity'],['story','Origin or Special Story'],['dimensions','Approximate Size/Dimensions'],
 ['pieces','Number of Pieces'],['materials','Materials'],['fragile','Is your nativity fragile or requires special handling']
];
const date = value => value ? new Date(value+'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',month:'long',day:'numeric',year:'numeric'}) : 'Not scheduled';
function clean(value) { return String(value ?? '').replace(/[\u2018\u2019]/g,"'").replace(/[\u201c\u201d]/g,'"').replace(/[\u2013\u2014]/g,'-').replace(/[^\x20-\x7E]/g,' '); }

export async function createWaiverPdf(record, signedImage = null, mime = '') {
  const pdf=await PDFDocument.create();
  const regular=await pdf.embedFont(StandardFonts.Helvetica);
  const bold=await pdf.embedFont(StandardFonts.HelveticaBold);
  let page=pdf.addPage([612,792]), y=755;
  const left=46, width=520;
  function newPage(){page=pdf.addPage([612,792]);y=755;}
  function line(text,size=10,heavy=false,indent=0){
    const font=heavy?bold:regular, words=clean(text).split(/\s+/);
    let current='';
    for(const word of words) {
      const candidate=current?current+' '+word:word;
      if(font.widthOfTextAtSize(candidate,size)>width-indent && current){draw(current);current=word;} else current=candidate;
    }
    if(current)draw(current);
    function draw(value){if(y<54)newPage();page.drawText(value,{x:left+indent,y,size,font,color:rgb(0,0,0)});y-=size+5;}
  }
  function gap(n=9){y-=n;}
  line('A Stroll to the Stable - Registration & Release Form',15,true);
  gap();
  line('Event: Stroll to the Stable');
  line('Dates: '+date(record.dates.start)+' - '+date(record.dates.end));
  line('Event Location: Nolte Building (formerly Wells Fargo) at 101 E. Nolte in downtown Seguin');
  gap();line('Participant Information',12,true);
  for(const [key,label] of labels.slice(0,5))line(label+': '+(record.fields[key]||''));
  gap();line('Nativity Information',12,true);
  const n=record.nativity||{};
  line('Submission Number: '+(n.submissionNumber||record.submissionNumber||''));
  line('Event Year: '+(n.eventYear||record.year||''));
  line('Story / Origin: '+(n.story||'Not provided'));
  line('Total Pieces: '+(n.pieceCount??''));
  if(n.photoKey)line('Nativity Photo Reference: '+n.photoKey,9);
  if(n.displayPhotoKey)line('Display Photo Reference: '+n.displayPhotoKey,9);
  gap(4);line('Individual Pieces',11,true);
  for(const p of n.pieces||[]){
    line('Piece '+p.piece_number+': '+(p.description||''));
    line('Condition: '+(p.condition_notes||''),9);
    if(p.photo_key)line('Photo Reference: '+p.photo_key,9);
  }
  gap();line('Liability & Release Agreement',12,true);
  line('I, the undersigned, acknowledge that I am voluntarily lending my personal nativity set and its listed pieces ("Property"), for use in "A Stroll to the Stable" hosted by City of Seguin ("Organizer"). I understand and agree to the following:');
  gap(5);
  for(const item of [
    '1. My participation is voluntary, and I assume all risks associated with displaying my property.',
    '2. The Organizer will take reasonable precautions but cannot guarantee against damage, loss, or theft.',
    '3. I release and hold harmless the Organizer, its staff, volunteers, affiliates, and sponsors from any liability for loss, damage, or injury to my property or person arising from my participation in the event.',
    '4. I agree that photos/videos of my display may be used for promotional purposes.',
    '5. Unclaimed displays after the designated pick-up date '+date(record.dates.pickupDeadline)+' may be considered donations.'
  ]){line(item);gap(3);}
  gap(8);
  line('Electronic Signature and Consent',12,true);
  const consent='I have reviewed the complete Registration and Release Agreement, understand its terms, and agree that my electronic signature is legally binding.';
  line((record.electronicSignatureConsent===true?'[X]':'[ ]')+' '+consent,10);
  gap(8);
  line('Signature:',10,true);
  if(record.signatureImage){
    const bytes=Uint8Array.from(atob(record.signatureImage.split(',')[1]),c=>c.charCodeAt(0));
    const image=await pdf.embedPng(bytes);
    const w=Math.min(310,image.width*0.7),h=Math.min(105,image.height*w/image.width);
    if(y-h<54)newPage();
    page.drawImage(image,{x:left,y:y-h,width:w,height:h});
    y-=h+8;
  } else line(record.signature||'________________________________');
  line('Date: '+(record.signingDate?date(record.signingDate):record.completedAt?new Date(record.completedAt).toLocaleDateString('en-US',{timeZone:'UTC'}):'________________'));
  line('Printed Name of Signer: '+(record.signerName||'________________'));
  gap(8);
  line('Electronic Signing Audit Trail',11,true);
  const audit=record.audit||{};
  line('Server Timestamp (UTC): '+(audit.signedAt||'Pending signature'));
  line('IP Address: '+(audit.ipAddress||'Not available'));
  line('Browser / User Agent: '+(audit.userAgent||'Not available'),9);
  line('Authenticated Account ID: '+(audit.authenticatedUserId??'Not yet signed'),9);
  line('Reviewed PDF SHA-256: '+(audit.reviewedPdfSha256||'Pending review'),8);
  line('Document Reviewed At (UTC): '+(audit.reviewedAt||'Pending review'),9);
  line('Electronic Consent: '+(record.electronicSignatureConsent===true?'Checked and accepted':'Not yet accepted'));
  if(signedImage){
    let img;
    if(mime==='image/png')img=await pdf.embedPng(signedImage);
    else if(mime==='image/jpeg')img=await pdf.embedJpg(signedImage);
    else throw new Error('Only JPEG or PNG scans are supported.');
    const p=pdf.addPage([612,792]);const scale=Math.min(540/img.width,720/img.height);
    p.drawImage(img,{x:(612-img.width*scale)/2,y:(792-img.height*scale)/2,width:img.width*scale,height:img.height*scale});
  }
  return pdf.save();
}
