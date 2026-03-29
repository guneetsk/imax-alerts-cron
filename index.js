const { neon } = require('@neondatabase/serverless');
const nodemailer = require('nodemailer');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SCREENS_DATA = require('./imax-screens.json');
const screenMap = {};
for (const s of SCREENS_DATA) screenMap[s.venueCode] = s.regionCode;

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com', port: 587, secure: false,
  auth: { user: 'alerts.guneet@gmail.com', pass: process.env.GMAIL_APP_PASSWORD }
});

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDate(dc) {
  return new Date(+dc.slice(0, 4), +dc.slice(4, 6) - 1, +dc.slice(6, 8))
    .toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' });
}

async function fetchBMS(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 80)}`);
  }
  return await res.json();
}

async function main() {
  const sql = neon(process.env.DATABASE_URL);

  // 0. Test BMS connectivity with today's date (known working)
  const today = new Date();
  const todayCode = today.getFullYear().toString() + String(today.getMonth()+1).padStart(2,'0') + String(today.getDate()).padStart(2,'0');
  try {
    const testData = await fetchBMS(`https://in.bookmyshow.com/api/v3/mobile/showtimes/byvenue?venueCode=PAEG&regionCode=NCR&dateCode=${todayCode}&appCode=WEB`);
    console.log(`BMS connectivity test (PAEG/${todayCode}): OK, ${(testData.ShowDetails || []).length} days`);
  } catch (e) {
    console.error(`BMS connectivity test FAILED: ${e.message?.slice(0, 80)}`);
  }

  // 1. Get active subscriptions
  const subs = await sql.query("SELECT * FROM subscriptions WHERE active = true AND email_verified = true");
  if (subs.length === 0) { console.log('No active subscriptions.'); return; }
  console.log(`Found ${subs.length} active subscription(s)`);

  // 2. Collect unique (venueCode, date) pairs
  const pairs = new Set();
  for (const sub of subs) {
    for (const vc of sub.venue_codes) {
      for (const dc of sub.target_dates) {
        pairs.add(vc + '|' + dc);
      }
    }
  }
  console.log(`Need to check ${pairs.size} venue/date pairs`);

  // 3. Fetch BMS data via curl (same method as the working personal bot)
  const showsByPair = {};
  for (const pair of pairs) {
    const [vc, dc] = pair.split('|');
    const rc = screenMap[vc];
    if (!rc) continue;
    const url = `https://in.bookmyshow.com/api/v3/mobile/showtimes/byvenue?venueCode=${vc}&regionCode=${rc}&dateCode=${dc}&appCode=WEB`;
    try {
      const data = await fetchBMS(url);
      const shows = [];
      for (const day of (data.ShowDetails || [])) {
        for (const ev of (day.Event || [])) {
          for (const child of (ev.ChildEvents || [])) {
            if (!(child.EventDimension || '').toUpperCase().includes('IMAX')) continue;
            for (const st of (child.ShowTimes || [])) {
              if (st.AvailStatus === '0') continue;
              shows.push({
                eventCode: child.EventCode, eventName: child.EventName,
                date: dc, time: st.ShowTime, dateTime: st.ShowDateTime,
                sessionId: st.SessionId,
                availStatus: st.AvailStatus === '1' ? 'available' : 'fast-filling',
                minPrice: st.MinPrice, maxPrice: st.MaxPrice,
                screenName: st.ScreenName || 'IMAX',
                bookingUrl: `https://in.bookmyshow.com/${rc.toLowerCase()}/movies/${child.EventCode}/${dc}`
              });
            }
          }
        }
      }
      if (shows.length > 0) {
        showsByPair[pair] = shows;
        console.log(`  ${pair}: ${shows.length} IMAX shows`);
      } else {
        console.log(`  ${pair}: no IMAX shows`);
      }
    } catch (e) {
      console.warn(`  ${pair}: FAILED - ${e.message?.slice(0, 100)}`);
    }
    // Rate limit: 500ms between requests
    await new Promise(r => setTimeout(r, 500));
  }

  // 4. Match to subscriptions and send alerts
  let emailsSent = 0;
  for (const sub of subs) {
    const matched = [];
    for (const vc of sub.venue_codes) {
      for (const dc of sub.target_dates) {
        const shows = showsByPair[vc + '|' + dc];
        if (!shows) continue;
        const movieShows = shows.filter(s => s.eventCode === sub.movie_event_code);
        const newShows = movieShows.filter(s => {
          const key = `${s.date}-${s.dateTime}-${s.sessionId}`;
          return !(sub.notified_show_keys || []).includes(key);
        });
        matched.push(...newShows);
      }
    }

    // Update last_checked_at
    await sql.query("UPDATE subscriptions SET last_checked_at = NOW() WHERE id = $1", [sub.id]);

    if (matched.length === 0) {
      console.log(`  Sub ${sub.id.slice(0, 8)}: no new shows`);
      continue;
    }

    // Send alert email
    const rows = matched.map(s => `<tr>
      <td style="padding:8px;border-bottom:1px solid #eee">${formatDate(s.date)}</td>
      <td style="padding:8px;border-bottom:1px solid #eee"><strong>${escapeHtml(s.time)}</strong></td>
      <td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(s.screenName)}</td>
      <td style="padding:8px;border-bottom:1px solid #eee">${s.availStatus === 'available' ? 'Available' : 'Fast Filling'}</td>
      <td style="padding:8px;border-bottom:1px solid #eee">Rs ${s.minPrice}-${s.maxPrice}</td>
      <td style="padding:8px;border-bottom:1px solid #eee"><a href="${s.bookingUrl}" style="color:#4f46e5;font-weight:bold">Book Now</a></td>
    </tr>`).join('');

    const unsubUrl = `https://imaxalerts.guneetsk.com/api/unsubscribe?token=${sub.unsubscribe_token}`;
    try {
      await transporter.sendMail({
        from: '"IMAX Alerts" <alerts.guneet@gmail.com>',
        to: sub.email,
        subject: `Bookings open! ${sub.movie_name} IMAX tickets are live`,
        html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto">
          <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed,#9333ea);padding:32px 24px;border-radius:16px 16px 0 0">
            <h2 style="color:#fff;margin:0 0 4px 0;font-size:20px;font-weight:700">IMAX Alerts</h2>
            <p style="color:rgba(255,255,255,0.9);margin:0;font-size:16px;font-weight:600">Bookings are open!</p>
          </div>
          <div style="background:#fff;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 16px 16px">
            <p style="color:#374151;font-size:15px;margin:0 0 16px 0"><strong>${escapeHtml(sub.movie_name)}</strong> — ${matched.length} IMAX show(s) found:</p>
            <table style="border-collapse:collapse;width:100%;font-size:14px">
              <tr style="background:#f3f2ff">
                <th style="padding:10px 8px;text-align:left;color:#4f46e5;font-size:12px;text-transform:uppercase">Date</th>
                <th style="padding:10px 8px;text-align:left;color:#4f46e5;font-size:12px;text-transform:uppercase">Time</th>
                <th style="padding:10px 8px;text-align:left;color:#4f46e5;font-size:12px;text-transform:uppercase">Screen</th>
                <th style="padding:10px 8px;text-align:left;color:#4f46e5;font-size:12px;text-transform:uppercase">Status</th>
                <th style="padding:10px 8px;text-align:left;color:#4f46e5;font-size:12px;text-transform:uppercase">Price</th>
                <th style="padding:10px 8px;text-align:left;color:#4f46e5;font-size:12px;text-transform:uppercase">Link</th>
              </tr>
              ${rows}
            </table>
            <p style="margin:20px 0 0 0;color:#6b7280;font-size:13px">This alert has been automatically deactivated.</p>
            <p style="color:#9ca3af;font-size:12px;margin:12px 0 0 0"><a href="${unsubUrl}" style="color:#9ca3af">Unsubscribe</a> &middot; IMAX Alerts by guneetsk.com</p>
          </div>
        </div>`
      });
      emailsSent++;
      console.log(`  Sub ${sub.id.slice(0, 8)}: ALERT SENT to ${sub.email} (${matched.length} shows)`);

      const newKeys = matched.map(s => `${s.date}-${s.dateTime}-${s.sessionId}`);
      const allKeys = [...(sub.notified_show_keys || []), ...newKeys];
      await sql.query("UPDATE subscriptions SET active = false, notified_at = NOW(), notified_show_keys = $1 WHERE id = $2", [allKeys, sub.id]);
    } catch (e) {
      console.error(`  Sub ${sub.id.slice(0, 8)}: EMAIL FAILED: ${e.message}`);
    }
  }

  console.log(`\nDone. Checked ${pairs.size} pairs, sent ${emailsSent} alerts.`);
}

main().catch(e => { console.error(e); process.exit(1); });
