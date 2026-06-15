// Cloudflare Worker 邮件转发处理器
// 功能：接收自建域名邮箱的邮件，根据主题结尾的 "#&, target@example.com" 指令，
// 将邮件原封不动转发到目标邮箱，同时删除主题中的指令部分。
// 安全：仅处理白名单中的发件人邮件，其他人邮件被静默忽略。

// ========== 配置区域（通过环境变量设置，更安全） ==========
// 环境变量说明：
// - RESEND_API_KEY: Resend API密钥，必填
// - FROM_EMAIL: 转发邮件的发件人地址（需在Resend中验证），例如 "forward@yourdomain.com"
// - ALLOWED_SENDERS: 白名单邮箱，逗号分隔，例如 "me@gmail.com,my@proton.me"
// - ENABLE_REPLY_TO: 是否设置Reply-To为原始发件人，默认 "true"
// =========================================================

/**
 * 将 Uint8Array 转换为 Base64 字符串
 * @param {Uint8Array} uint8Array
 * @returns {string}
 */
function uint8ArrayToBase64(uint8Array) {
  // 使用二进制字符串中转，适用于任何二进制数据
  let binary = '';
  const len = uint8Array.length;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(uint8Array[i]);
  }
  return btoa(binary);
}

/**
 * 检查邮箱地址是否在白名单中
 * @param {string} sender 发件人邮箱
 * @param {string[]} allowedList 白名单数组
 * @returns {boolean}
 */
function isAllowedSender(sender, allowedList) {
  if (!allowedList || allowedList.length === 0) return false;
  const normalizedSender = sender.toLowerCase().trim();
  return allowedList.some(allowed => allowed.toLowerCase().trim() === normalizedSender);
}

/**
 * 从主题末尾解析目标邮箱地址，并返回新主题和目标邮箱
 * 格式：主题内容 #&, target@example.com
 * @param {string} subject 原始主题
 * @returns {{ newSubject: string, targetEmail: string | null }}
 */
function parseTargetFromSubject(subject) {
  // 匹配结尾的模式：#&, 任意空格，然后是邮箱地址（直到结尾）
  // 支持 #& 后面可能有逗号，参考用户描述 (#&, xxx@xxx.com)
  const pattern = /#&,\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\s*$/;
  const match = subject.match(pattern);
  if (!match) {
    return { newSubject: subject, targetEmail: null };
  }
  const targetEmail = match[1];
  // 删除匹配到的模式部分（包括前面的任何空格，保留主题其余部分）
  const newSubject = subject.replace(pattern, '').trim();
  // 如果新主题为空，设置一个默认主题（避免空主题）
  const finalSubject = newSubject === '' ? '(无主题)' : newSubject;
  return { newSubject: finalSubject, targetEmail };
}

/**
 * 通过 Resend API 发送邮件
 * @param {Object} params
 * @param {string} params.from 发件人
 * @param {string} params.to 收件人
 * @param {string} params.subject 主题
 * @param {string|null} params.html HTML正文
 * @param {string|null} params.text 纯文本正文
 * @param {Array} params.attachments 附件数组（Resend格式）
 * @param {string|null} params.replyTo 回复地址
 * @param {string} apiKey Resend API密钥
 * @returns {Promise<Response>}
 */
async function sendViaResend({ from, to, subject, html, text, attachments, replyTo }, apiKey) {
  const payload = {
    from,
    to: [to],
    subject,
    reply_to: replyTo ? [replyTo] : undefined,
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
  };
  // 优先使用 HTML，其次纯文本
  if (html) {
    payload.html = html;
  } else if (text) {
    payload.text = text;
  } else {
    // 没有任何内容时，设置一个占位文本，避免发送失败
    payload.text = '(邮件内容为空)';
  }

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return resp;
}

/**
 * 主邮件处理函数
 * @param {ForwardableEmailMessage} message Cloudflare Email 消息对象
 * @param {Env} env 环境变量
 */
async function handleEmail(message, env) {
  // 1. 白名单检查
  const allowedSendersRaw = env.ALLOWED_SENDERS || '';
  const allowedList = allowedSendersRaw.split(',').map(s => s.trim()).filter(s => s);
  const sender = message.from;
  
  if (!isAllowedSender(sender, allowedList)) {
    console.log(`[安全] 发件人 ${sender} 不在白名单中，邮件被忽略。`);
    return; // 静默忽略，不回复、不转发
  }

  // 2. 解析主题，获取目标邮箱和清理后的主题
  const originalSubject = message.subject || '';
  const { newSubject, targetEmail } = parseTargetFromSubject(originalSubject);
  
  if (!targetEmail) {
    console.log(`[跳过] 主题末尾未找到目标邮箱指令。主题: ${originalSubject}`);
    return; // 无有效指令，忽略
  }
  
  console.log(`[解析] 目标邮箱: ${targetEmail}, 清理后主题: ${newSubject}`);

  // 3. 准备邮件内容（正文、附件等，原封不动）
  // 获取正文：优先 HTML，否则纯文本
  let html = message.html;
  let text = message.plainText;
  
  // 处理附件格式转换为 Resend 所需格式
  const attachments = [];
  if (message.attachments && message.attachments.length > 0) {
    for (const attachment of message.attachments) {
      // attachment.content 是 Uint8Array
      const base64Content = uint8ArrayToBase64(attachment.content);
      attachments.push({
        filename: attachment.name,
        content: base64Content,
        content_type: attachment.contentType || 'application/octet-stream',
      });
    }
  }

  // 4. 构造 Reply-To (可选)
  let replyTo = null;
  if (env.ENABLE_REPLY_TO !== 'false') { // 默认 true
    replyTo = sender;
  }

  // 5. 通过 Resend 发送
  const fromAddress = env.FROM_EMAIL;
  if (!fromAddress) {
    console.error('[错误] 未配置 FROM_EMAIL 环境变量，无法发送。');
    return;
  }
  if (!env.RESEND_API_KEY) {
    console.error('[错误] 未配置 RESEND_API_KEY 环境变量，无法发送。');
    return;
  }

  try {
    const sendResult = await sendViaResend({
      from: fromAddress,
      to: targetEmail,
      subject: newSubject,
      html,
      text,
      attachments,
      replyTo,
    }, env.RESEND_API_KEY);
    
    if (sendResult.ok) {
      const data = await sendResult.json();
      console.log(`[成功] 邮件已转发至 ${targetEmail}，Resend ID: ${data.id}`);
    } else {
      const errorText = await sendResult.text();
      console.error(`[失败] Resend 返回错误 ${sendResult.status}: ${errorText}`);
    }
  } catch (err) {
    console.error(`[异常] 转发过程中发生错误: ${err.message}`);
  }
}

/**
 * Worker 入口：监听 email 事件
 */
export default {
  async email(message, env, ctx) {
    // 使用 ctx.waitUntil 确保异步操作完成，避免 Worker 提前关闭
    ctx.waitUntil(handleEmail(message, env));
  },
};