// test-gmail-send.js - Unit tests for the Gmail API sender (gmail-send.js).
// Run: node test-gmail-send.js
// No network, no database: the Gmail API client is faked where a send is
// exercised, and the OAuth URL is only inspected, never opened.
const assert = require('assert');
const gmailSend = require('./gmail-send');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('PASS ' + name);
  } catch (e) {
    failed += 1;
    console.log('FAIL ' + name + ': ' + e.message);
  }
}

// Save and restore the env vars these tests touch.
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function main() {
  await test('buildRawMessage: headers present and decodes cleanly', () => {
    const raw = gmailSend.buildRawMessage('H-CAR <talonfisher66@gmail.com>', 'meaganbourquin@gmail.com', 'H-CAR test alert', 'Hello,\n\nThis is a test.');
    assert.ok(!raw.includes('+') && !raw.includes('/') && !raw.includes('='), 'base64url has no + / or = padding');
    const text = gmailSend.decodeRawMessage(raw);
    assert.ok(text.includes('From: H-CAR <talonfisher66@gmail.com>'), 'From header');
    assert.ok(text.includes('To: meaganbourquin@gmail.com'), 'To header');
    assert.ok(text.includes('Subject: H-CAR test alert'), 'Subject header');
    assert.ok(text.includes('Content-Type: text/plain; charset="UTF-8"'), 'content type');
    assert.ok(text.includes('Hello,\n\nThis is a test.'), 'body intact');
  });

  await test('buildRawMessage: non-ASCII subject is RFC 2047 encoded and round-trips', () => {
    const subject = 'Alerte H-CAR pour Méagan';
    const raw = gmailSend.buildRawMessage('a@b.com', 'c@d.com', subject, 'body');
    const text = gmailSend.decodeRawMessage(raw);
    const subjectLine = text.split('\r\n').find((l) => l.startsWith('Subject: '));
    assert.ok(subjectLine.includes('=?UTF-8?B?'), 'encoded-word present: ' + subjectLine);
    const b64 = subjectLine.slice('Subject: =?UTF-8?B?'.length, -2);
    assert.strictEqual(Buffer.from(b64, 'base64').toString('utf8'), subject, 'subject decodes to the original');
  });

  await test('gmailSenderAddress: env precedence and bare-address extraction', () => {
    withEnv({ GMAIL_FROM: 'H-CAR <talonfisher66@gmail.com>', SMTP_FROM: 'Other <other@example.com>', SMTP_USER: 'smtp@example.com' }, () => {
      assert.strictEqual(gmailSend.gmailSenderAddress(), 'talonfisher66@gmail.com');
    });
    withEnv({ GMAIL_FROM: undefined, SMTP_FROM: 'H-CAR <talonfisher66@gmail.com>', SMTP_USER: 'smtp@example.com' }, () => {
      assert.strictEqual(gmailSend.gmailSenderAddress(), 'talonfisher66@gmail.com');
    });
    withEnv({ GMAIL_FROM: undefined, SMTP_FROM: undefined, SMTP_USER: 'plain@example.com' }, () => {
      assert.strictEqual(gmailSend.gmailSenderAddress(), 'plain@example.com');
    });
    withEnv({ GMAIL_FROM: undefined, SMTP_FROM: undefined, SMTP_USER: undefined }, () => {
      assert.strictEqual(gmailSend.gmailSenderAddress(), 'talonfisher66@gmail.com');
    });
  });

  await test('isGmailApiConfigured: needs refresh token plus OAuth client', () => {
    withEnv({ GMAIL_REFRESH_TOKEN: 'tok', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec' }, () => {
      assert.strictEqual(gmailSend.isGmailApiConfigured(), true);
    });
    withEnv({ GMAIL_REFRESH_TOKEN: undefined, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec' }, () => {
      assert.strictEqual(gmailSend.isGmailApiConfigured(), false);
    });
    withEnv({ GMAIL_REFRESH_TOKEN: 'tok', GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: 'sec' }, () => {
      assert.strictEqual(gmailSend.isGmailApiConfigured(), false);
    });
  });

  await test('getGmailAuthUrl: gmail.send scope only, offline, consent, redirect', () => {
    withEnv({ GOOGLE_CLIENT_ID: 'test-id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-secret', BASE_URL: 'https://h-car.onrender.com' }, () => {
      const url = gmailSend.getGmailAuthUrl('state123');
      assert.ok(url.includes('scope=' + encodeURIComponent(gmailSend.GMAIL_SEND_SCOPE)), 'scope is gmail.send only: ' + url);
      assert.ok(!url.includes('googlehealth'), 'no health scopes leak into the mail consent');
      assert.ok(url.includes('access_type=offline'), 'offline access for a refresh token');
      assert.ok(url.includes('prompt=consent'), 'consent forced so a refresh token is issued');
      assert.ok(url.includes('state=state123'), 'state carried');
      assert.ok(url.includes('redirect_uri=' + encodeURIComponent('https://h-car.onrender.com/api/admin/gmail-auth-callback')), 'callback redirect URI');
    });
  });

  await test('auth state: unique, single-use, rejects unknown states', () => {
    const s1 = gmailSend.createGmailAuthState();
    const s2 = gmailSend.createGmailAuthState();
    assert.notStrictEqual(s1, s2, 'states differ');
    assert.strictEqual(gmailSend.consumeGmailAuthState(s1), true, 'first use valid');
    assert.strictEqual(gmailSend.consumeGmailAuthState(s1), false, 'reuse rejected');
    assert.strictEqual(gmailSend.consumeGmailAuthState('nope'), false, 'unknown state rejected');
    assert.strictEqual(gmailSend.consumeGmailAuthState(null), false, 'null rejected');
    assert.strictEqual(gmailSend.consumeGmailAuthState(s2), true, 'second state still valid');
  });

  await test('sendViaGmailApi: success returns sent with id, raw decodes', async () => {
    let captured = null;
    const fake = {
      users: {
        messages: {
          send: async (params) => {
            captured = params;
            return { data: { id: 'msg-123' } };
          },
        },
      },
    };
    const result = await gmailSend.sendViaGmailApi('meaganbourquin@gmail.com', 'H-CAR test', 'Test body', fake);
    assert.strictEqual(result.sent, true, 'sent');
    assert.strictEqual(result.via, 'gmail-api', 'via gmail-api');
    assert.strictEqual(result.id, 'msg-123', 'message id returned');
    assert.strictEqual(captured.userId, 'me', 'sent as me');
    const text = gmailSend.decodeRawMessage(captured.requestBody.raw);
    assert.ok(text.includes('To: meaganbourquin@gmail.com'), 'recipient in raw message');
    assert.ok(text.includes('Test body'), 'body in raw message');
  });

  await test('sendViaGmailApi: API failure returns honest reason, never throws', async () => {
    const failing = {
      users: {
        messages: {
          send: async () => {
            const err = new Error('Request failed with status code 401');
            err.response = { data: { error: { message: 'Invalid Credentials' } } };
            throw err;
          },
        },
      },
    };
    const result = await gmailSend.sendViaGmailApi('a@b.com', 'Subj', 'body', failing);
    assert.strictEqual(result.sent, false, 'not sent');
    assert.ok(result.reason.includes('Invalid Credentials'), 'server error surfaced: ' + result.reason);
  });

  await test('sendViaGmailApi: unconfigured without override reports not configured', async () => {
    await withEnv({ GMAIL_REFRESH_TOKEN: undefined }, async () => {
      const result = await gmailSend.sendViaGmailApi('a@b.com', 'Subj', 'body');
      assert.strictEqual(result.sent, false, 'not sent');
      assert.ok(result.reason.includes('not configured'), 'reason names the missing setup: ' + result.reason);
    });
  });

  await test('no em dashes in module source', () => {
    const fs = require('fs');
    const src = fs.readFileSync(__dirname + '/gmail-send.js', 'utf8');
    assert.ok(!src.includes('—'), 'gmail-send.js must not contain em dashes');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed.');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Test runner crashed:', e);
  process.exit(1);
});
