// ================== CONFIG ==================
const TEACHER_EMAIL = 'tranngoctanxpxtnd@gmail.com';
const DRIVE_FOLDER_ID = '1wGCEVjco6pginGxn-X1osLseLjyqQOdl';

// Lưu các mảnh (chunk) tạm vào Drive luôn (trong cùng folder) để không phụ thuộc cache/properties
const TMP_PREFIX = 'TMP_AUDIO_CHUNK__';

// ================== WEB APP ==================
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('New Tran Speaking API')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Netlify POST JSON bằng Content-Type text/plain
 * body: { action: "...", ... }
 */
function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '';
    const obj = raw ? JSON.parse(raw) : {};
    const action = obj.action || '';

    if (action === 'submitAll') {
      // 1-shot: transcript + (optional) audio dataUrl
      return handleSubmitAll_(obj);
    }

    if (action === 'uploadChunk') {
      // chunk upload: {uploadId, idx, total, mimeType, b64}
      return handleUploadChunk_(obj);
    }

    if (action === 'finalizeUpload') {
      // finalize + send email: {uploadId, total, mimeType, studentName, studentClass, topicLabel, questionSummary, transcript}
      return handleFinalizeUpload_(obj);
    }

    return jsonOut_({ ok: false, message: 'Unknown action: ' + action });
  } catch (err) {
    console.error(err);
    return jsonOut_({ ok: false, message: 'Server error: ' + (err ? err.toString() : 'Unknown error') });
  }
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ================== HANDLERS ==================
function handleSubmitAll_(obj) {
  const studentName = obj.studentName || '';
  const studentClass = obj.studentClass || '';
  const topicLabel = obj.topicLabel || 'Topic';
  const questionSummary = obj.questionSummary || `${topicLabel} – 10-question speaking practice`;
  const transcript = obj.transcript || '';

  const mimeType = obj.mimeType || '';
  const dataUrl = obj.dataUrl || '';

  if (!studentName || !studentClass || !questionSummary) {
    return jsonOut_({ ok: false, message: 'Missing studentName/studentClass/questionSummary' });
  }

  let audioUrl = '';
  let uploadInfo = null;

  if (dataUrl && mimeType) {
    uploadInfo = uploadFullAudio_({
      studentName, studentClass, topicLabel, mimeType, dataUrl
    });
    if (uploadInfo && uploadInfo.ok) audioUrl = uploadInfo.url;
  }

  const r = sendTranscriptWithAudioLink_(studentName, studentClass, questionSummary, transcript, audioUrl);

  return jsonOut_({
    ok: !!(r && r.ok),
    message: (r && r.message) ? r.message : 'Done',
    audioUrl: audioUrl || '',
    upload: uploadInfo || null
  });
}

function handleUploadChunk_(obj) {
  const uploadId = obj.uploadId || '';
  const idx = Number(obj.idx);
  const total = Number(obj.total);
  const mimeType = obj.mimeType || 'application/octet-stream';
  const b64 = obj.b64 || '';

  if (!uploadId || !Number.isFinite(idx) || !Number.isFinite(total) || !b64) {
    return jsonOut_({ ok: false, message: 'Missing uploadId/idx/total/b64' });
  }

  // decode bytes từ chunk base64
  const bytes = Utilities.base64Decode(String(b64));
  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);

  // lưu chunk thành file tạm
  const name = `${TMP_PREFIX}${uploadId}__${String(idx).padStart(4, '0')}of${String(total).padStart(4, '0')}.bin`;
  const blob = Utilities.newBlob(bytes, 'application/octet-stream', name);
  const f = folder.createFile(blob);

  return jsonOut_({ ok: true, message: 'Chunk saved', fileId: f.getId() });
}

function handleFinalizeUpload_(obj) {
  const uploadId = obj.uploadId || '';
  const total = Number(obj.total);
  const mimeType = obj.mimeType || 'audio/webm';

  const studentName = obj.studentName || '';
  const studentClass = obj.studentClass || '';
  const topicLabel = obj.topicLabel || 'Topic';
  const questionSummary = obj.questionSummary || `${topicLabel} – 10-question speaking practice`;
  const transcript = obj.transcript || '';

  if (!uploadId || !Number.isFinite(total) || total <= 0) {
    return jsonOut_({ ok: false, message: 'Missing uploadId/total' });
  }
  if (!studentName || !studentClass) {
    return jsonOut_({ ok: false, message: 'Missing studentName/studentClass' });
  }

  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);

  // gom chunk theo prefix uploadId
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    const nm = f.getName();
    if (nm.indexOf(`${TMP_PREFIX}${uploadId}__`) === 0) {
      // parse idx từ tên
      const m = nm.match(/__([0-9]{4})of/);
      const idx = m ? parseInt(m[1], 10) : 999999;
      files.push({ idx, file: f });
    }
  }

  files.sort((a, b) => a.idx - b.idx);

  if (files.length < total) {
    // thiếu chunk => không ghép được
    return jsonOut_({ ok: false, message: `Missing chunks: got ${files.length}/${total}` });
  }

  // concat bytes
  let totalBytes = 0;
  const partsBytes = [];
  for (let i = 0; i < total; i++) {
    const partFile = files[i].file;
    const bytes = partFile.getBlob().getBytes();
    partsBytes.push(bytes);
    totalBytes += bytes.length;
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const arr of partsBytes) {
    merged.set(arr, offset);
    offset += arr.length;
  }

  // tạo file final
  const ext =
    mimeType.includes('wav') ? 'wav' :
    mimeType.includes('ogg') ? 'ogg' :
    mimeType.includes('webm') ? 'webm' : 'dat';

  const safeName  = String(studentName).trim().replace(/[\\/:*?"<>|]/g, '_');
  const safeClass = String(studentClass).trim().replace(/[\\/:*?"<>|]/g, '_');
  const ts = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd_HHmmss');
  const filename = `[SpeakingFull]_${safeName}_Lop${safeClass}_${ts}.${ext}`;

  const finalBlob = Utilities.newBlob(Array.from(merged), mimeType, filename);
  const finalFile = folder.createFile(finalBlob);
  finalFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const audioUrl = finalFile.getUrl();

  // xóa chunk tạm
  for (let i = 0; i < total; i++) {
    try { files[i].file.setTrashed(true); } catch (e) {}
  }

  // gửi email
  const r = sendTranscriptWithAudioLink_(studentName, studentClass, questionSummary, transcript, audioUrl);

  return jsonOut_({
    ok: !!(r && r.ok),
    message: (r && r.message) ? r.message : 'Finalized',
    audioUrl
  });
}

// ================== EMAIL ==================
function sendTranscriptWithAudioLink_(studentName, studentClass, question, transcript, audioUrl) {
  try {
    const now = new Date();
    const timeString = now.toLocaleString('vi-VN');
    const subject = `[Speaking App] ${studentName} - Lớp ${studentClass}`;

    const body =
      'New Tran English App – Transcript luyện nói\n' +
      '--------------------------------------------------\n' +
      'Họ tên HS: ' + studentName + '\n' +
      'Lớp: ' + studentClass + '\n' +
      'Thời gian nộp: ' + timeString + '\n\n' +
      '--- AUDIO (1 FILE FULL BÀI) ---\n' + (audioUrl ? audioUrl : '(no audio)') + '\n\n' +
      '--- CÂU HỎI / TOPIC ---\n' + question + '\n\n' +
      '--- TRANSCRIPT (HS NÓI) ---\n' + (transcript || '(no transcript)') + '\n\n' +
      '--------------------------------------------------\n' +
      'Hệ thống tự động gửi từ Google Apps Script.';

    GmailApp.sendEmail(TEACHER_EMAIL, subject, body);
    return { ok: true, message: 'Đã gửi transcript + audio link tới giáo viên!' };
  } catch (err) {
    console.error(err);
    return { ok: false, message: 'Lỗi gửi email: ' + (err ? err.toString() : 'Unknown error') };
  }
}

// ================== 1-shot upload (dataUrl) ==================
function uploadFullAudio_(payload) {
  try {
    const studentName  = payload.studentName;
    const studentClass = payload.studentClass;
    const topicLabel   = payload.topicLabel || 'Topic';
    const mimeType     = payload.mimeType || 'audio/webm';
    const dataUrl      = payload.dataUrl;

    const match = String(dataUrl).match(/^data:(.+?);base64,(.+)$/);
    if (!match) return { ok: false, message: 'Sai định dạng dataUrl.' };

    const bytes = Utilities.base64Decode(match[2]);

    const ext =
      mimeType.includes('wav')  ? 'wav'  :
      mimeType.includes('ogg')  ? 'ogg'  :
      mimeType.includes('webm') ? 'webm' : 'dat';

    const safeName  = String(studentName).trim().replace(/[\\/:*?"<>|]/g, '_');
    const safeClass = String(studentClass).trim().replace(/[\\/:*?"<>|]/g, '_');
    const ts = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd_HHmmss');
    const filename = `[SpeakingFull]_${safeName}_Lop${safeClass}_${ts}.${ext}`;

    const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
    const blob = Utilities.newBlob(bytes, mimeType, filename);
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    return { ok: true, url: file.getUrl(), filename, topicLabel };
  } catch (err) {
    console.error(err);
    return { ok: false, message: 'Lỗi upload audio: ' + (err ? err.toString() : 'Unknown error') };
  }
}
