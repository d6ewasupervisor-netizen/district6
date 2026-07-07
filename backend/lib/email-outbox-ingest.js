function outboxBaseUrl() {
  return String(process.env.EMAIL_OUTBOX_URL || 'https://eod-api.the-dump-bin.com').replace(/\/+$/, '');
}

function ingestKey() {
  return String(process.env.EMAIL_OUTBOX_INGEST_KEY || '').trim();
}

function serializeAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter((a) => a && a.filename && a.content)
    .map((a) => ({
      filename: a.filename,
      content_type: a.content_type || a.contentType,
      content_base64: Buffer.isBuffer(a.content) ? a.content.toString('base64') : String(a.content),
    }));
}

export async function reportEmailOutbox(record) {
  const key = ingestKey();
  if (!key) return { skipped: true, reason: 'EMAIL_OUTBOX_INGEST_KEY unset' };

  const to = Array.isArray(record.to) ? record.to : String(record.to).split(',').map((s) => s.trim()).filter(Boolean);
  const cc = record.cc
    ? (Array.isArray(record.cc) ? record.cc : String(record.cc).split(',').map((s) => s.trim()).filter(Boolean))
    : [];
  const html = record.html || '';
  const text = record.text || '';
  const attachments = serializeAttachments(record.attachments);
  const storedPayload = record.storedPayload || {
    from: record.from,
    to,
    cc: cc.length ? cc : undefined,
    reply_to: record.replyTo,
    subject: record.subject,
    html: html || undefined,
    text: text || undefined,
    attachments: attachments.map((a) => ({
      filename: a.filename,
      content: a.content_base64,
      content_type: a.content_type,
    })),
  };

  try {
    const res = await fetch(`${outboxBaseUrl()}/api/email-outbox/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        sourceSystem: record.sourceSystem || 'district6',
        sourceType: record.sourceType,
        sourceRef: record.sourceRef,
        resendId: record.resendId,
        status: record.status || 'sent',
        from: record.from,
        to,
        cc,
        subject: record.subject,
        html,
        text,
        attachments,
        storedPayload,
        resendAllowed: record.resendAllowed,
        sentByEmail: record.sentByEmail,
        metadata: record.metadata || {},
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
    return { ok: true, id: body.id, updated: body.updated };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function reportResendPayload(sourceType, payload, result, extra = {}) {
  const resendId = result?.data?.id;
  const status = result?.error ? 'failed' : 'sent';
  return reportEmailOutbox({
    sourceSystem: extra.sourceSystem || 'district6',
    sourceType,
    sourceRef: extra.sourceRef,
    resendId,
    status,
    from: payload.from,
    to: payload.to,
    cc: payload.cc,
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
    attachments: payload.attachments,
    resendAllowed: extra.resendAllowed,
    sentByEmail: extra.sentByEmail,
    metadata: extra.metadata,
  });
}
