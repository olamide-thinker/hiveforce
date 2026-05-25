/**
 * MQTT realtime transport for sync-rn.
 *
 * sync-rn's bridge expects a service exposing:
 *   - `status`           → MqttConnectionStatus enum value
 *   - `subscribeToTenant(tenant)` → subscribe to per-tenant topics
 *
 * Our backend (NestJS RealtimeService) publishes change events on
 * `proj/{projectId}/{entity}` whenever a row is created / updated /
 * deleted. The phone subscribes to `proj/{projectId}/+` and, on
 * incoming message, fires a focused manualSync for the affected
 * entity. We don't try to apply the patch directly — the publish
 * payload is a hint, not the row — so the next pull fetches the
 * actual updated row via /api/<entity>?since=<cursor>.
 *
 * Transport
 * ─────────
 * mqtt.js works on RN over WebSocket Secure (wss://). HiveMQ Cloud
 * exposes both:
 *   - mqtts:// on 8883  (TCP + TLS — what the backend uses)
 *   - wss://   on 8884  (WebSocket + TLS — what we use here)
 *
 * Same broker, same auth, same topics — different port + protocol.
 * The wss URL is exposed via EXPO_PUBLIC_MQTT_WS_URL so dev /
 * staging / prod can swap without a rebuild.
 */
import mqtt, { type MqttClient } from 'mqtt';
import { MqttConnectionStatus } from '@syncsalez-dev/sync-rn';

import type { Tenant } from './tenant-store';
import { pullAll } from './local-sync';

type StatusValue =
  | MqttConnectionStatus.Connected
  | MqttConnectionStatus.Connecting
  | MqttConnectionStatus.Disconnected
  | MqttConnectionStatus.Error;

class MqttRealtimeService {
  private client: MqttClient | null = null;
  status: StatusValue = MqttConnectionStatus.Disconnected;

  // Track current subscription so reconnect / tenant-change can
  // unsubscribe cleanly.
  private subscribedTopic: string | null = null;

  /**
   * Subscribe to a tenant's topic. Called by sync-rn after the
   * bridge config is installed and the user has an active project.
   *
   * Called again on tenant change → re-subscribes to the new
   * project's topic.
   */
  async subscribeToTenant(tenant: Tenant): Promise<void> {
    const projectId = tenant?.branchId;
    if (!projectId) {
      // No active project → nothing to subscribe to. Pull-cursor
      // sync still works without realtime.
      this.disconnect();
      return;
    }

    const newTopic = `proj/${projectId}/+`;

    // Already connected and subscribed to this exact topic — no-op.
    if (
      this.client &&
      this.status === MqttConnectionStatus.Connected &&
      this.subscribedTopic === newTopic
    ) {
      return;
    }

    // Switching projects → drop the old client cleanly. mqtt.js
    // re-uses the underlying socket if we just re-subscribe, but
    // doing a fresh connect makes errors easier to reason about.
    if (this.client && this.subscribedTopic !== newTopic) {
      this.disconnect();
    }

    await this.connect(newTopic);
  }

  private async connect(topic: string): Promise<void> {
    const url = process.env.EXPO_PUBLIC_MQTT_WS_URL;
    const username = process.env.EXPO_PUBLIC_MQTT_USERNAME;
    const password = process.env.EXPO_PUBLIC_MQTT_PASSWORD;

    if (!url) {
      // Same posture as backend: missing config → silent no-op.
      // Pull-cursor sync still works. Realtime is opt-in.
      console.info('[mqtt] EXPO_PUBLIC_MQTT_WS_URL not set — realtime disabled');
      return;
    }

    this.status = MqttConnectionStatus.Connecting;

    this.client = mqtt.connect(url, {
      username,
      password,
      clean: true,
      // Random clientId per session — workers may install/uninstall
      // the app, and we don't need a stable session for QoS 0 pubs.
      clientId: `field-${Math.random().toString(36).slice(2, 10)}`,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
    });

    this.client.on('connect', () => {
      this.status = MqttConnectionStatus.Connected;
      this.subscribedTopic = topic;
      console.info('[mqtt] connected, subscribing to', topic);
      this.client?.subscribe(topic, { qos: 0 }, (err) => {
        if (err) {
          console.warn('[mqtt] subscribe failed:', err);
        }
      });
    });

    this.client.on('reconnect', () => {
      this.status = MqttConnectionStatus.Connecting;
    });

    this.client.on('close', () => {
      this.status = MqttConnectionStatus.Disconnected;
    });

    this.client.on('error', (err) => {
      this.status = MqttConnectionStatus.Error;
      console.warn('[mqtt] error:', err?.message ?? err);
    });

    this.client.on('message', (rawTopic, payload) => {
      // Topic shape: proj/{projectId}/{entity}
      const parts = rawTopic.split('/');
      const entity = parts[2];
      if (!entity) return;

      // Don't trust the payload as truth — backend publishes a
      // thin { id, action, updatedAt } envelope and we use it
      // only as a wake-up signal. The next manualSync for this
      // entity will fetch the actual row state from /api/<entity>
      // with the local cursor.
      try {
        const body = JSON.parse(payload.toString());
        console.debug('[mqtt] event', entity, body?.action ?? '?', body?.id);
      } catch {
        // Bad JSON — still fire a sync since something changed.
      }

      // Fire-and-forget. Multiple events in quick succession just
      // re-pull; the local cursor de-duplicates rows that haven't
      // changed since the last pull.
      pullAll([entity]).catch((err) => {
        console.warn('[mqtt] pull after event failed:', err);
      });
    });
  }

  private disconnect(): void {
    if (!this.client) return;
    try {
      this.client.end(true);
    } catch {
      /* ignore */
    }
    this.client = null;
    this.subscribedTopic = null;
    this.status = MqttConnectionStatus.Disconnected;
  }
}

export const mqttRealtimeService = new MqttRealtimeService();
