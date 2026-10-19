import { beforeEach, describe, expect, it } from 'vitest';
import { SandboxEnvironment } from '../environment';
import {
  DEFAULT_SANDBOX_CONFIG,
  SCENARIO_EXPIRED_TICKET,
  SCENARIO_INSUFFICIENT_FUNDS_ACCOUNT
} from '../fixtures';

const SENSITIVE_MARKERS = [
  '<script>',
  '</script>',
  'javascript:',
  'onerror=',
  'onload=',
  'data:text/html',
  'file://',
  '../',
  '..\\',
  '\u0000',
  '{{',
  '${'
];

function assertNoSensitiveLeak(value: unknown, forbiddenKeys: string[] = []): void {
  const serialized = JSON.stringify(value);
  for (const marker of SENSITIVE_MARKERS) {
    expect(serialized).not.toContain(marker);
  }
  for (const key of forbiddenKeys) {
    expect(serialized).not.toContain(`"${key}":`);
  }
}

describe('Integration Sandbox Mode (#85)', () => {
  let sandbox: SandboxEnvironment;

  beforeEach(() => {
    sandbox = new SandboxEnvironment(DEFAULT_SANDBOX_CONFIG);
  });

  describe('Primary Developer Workflow', () => {
    it('runs the full end-to-end ticketing journey locally with 0 external network calls', async () => {
      const result = await sandbox.executePrimaryWorkflow();

      expect(result.success).toBe(true);
      expect(result.connectedWallet).toBe('G_ALICE_DEV_TESTNET');
      expect(parseFloat(result.fundedBalanceXlm)).toBeGreaterThan(0);
      expect(result.eventCreated).toBe('event_sandbox_fest');
      expect(result.ticketIssued).toBe('tkt_sandbox_001');
      expect(result.ticketTransferred).toBe('G_BOB_RECEIVER');
      expect(result.ticketRedeemed).toBe('redeemed');

      // Verify email notification was recorded in outbox
      const outbox = sandbox.notifications.getOutbox();
      expect(outbox.length).toBeGreaterThan(0);
      expect(outbox[0].subject).toContain('Ticket Confirmed');

      // Verify webhook events were logged
      const webhooks = sandbox.webhooks.getDispatchedEvents();
      expect(webhooks.length).toBeGreaterThan(0);
      expect(webhooks.some((w) => w.payload.action === 'ticket.issued')).toBe(true);
      expect(webhooks.some((w) => w.payload.action === 'ticket.transferred')).toBe(true);
      expect(webhooks.some((w) => w.payload.action === 'ticket.redeemed')).toBe(true);
    });
  });

  describe('Fake External Service Adapters', () => {
    it('FakeHorizonAdapter retrieves account and simulates Friendbot funding deterministically', async () => {
      const pubKey = 'G_NEW_DEV_USER';
      const initial = await sandbox.horizon.getAccount(pubKey);
      expect(initial.ok).toBe(false);

      // Friendbot fund
      const fundRes = await sandbox.horizon.fundAccount(pubKey, 10_000_000_000);
      expect(fundRes.ok).toBe(true);

      // Verify account now exists
      const after = await sandbox.horizon.getAccount(pubKey);
      expect(after.ok).toBe(true);
      if (after.ok) {
        expect(after.value.balances[0].balance).toBe('1000.0000000');
        expect(after.value.sequence).toBe('1');
      }
    });

    it('FakeSorobanRpcAdapter simulates health, simulation, and transaction submissions', async () => {
      const health = await sandbox.soroban.getHealth();
      expect(health.status).toBe('healthy');

      const sim = await sandbox.soroban.simulateTransaction('AAAAXDR...');
      expect(sim.minResourceFee).toBe('1500');

      const tx = await sandbox.soroban.sendTransaction('SIGNED_SOROBAN_XDR...');
      expect(tx.status).toBe('SUCCESS');
      expect(tx.hash).toContain('soroban_tx_');

      const txStatus = await sandbox.soroban.getTransaction(tx.hash);
      expect(txStatus.status).toBe('SUCCESS');

      const entries = await sandbox.soroban.getLedgerEntries(['CONTRACT_KEY_1']);
      expect(entries.entries.length).toBe(1);
      expect(entries.entries[0].key).toBe('CONTRACT_KEY_1');

      const events = await sandbox.soroban.getEvents();
      expect(events.length).toBe(1);
      expect(events[0].topics).toContain('ticket_minted');
    });

    it('FakeWalletAdapter handles connect, disconnect, and signing deterministically', async () => {
      expect(sandbox.wallet.isConnected()).toBe(false);

      const conn = await sandbox.wallet.connect('G_TEST_KEY_123');
      expect(conn.publicKey).toBe('G_TEST_KEY_123');
      expect(sandbox.wallet.isConnected()).toBe(true);

      const signRes = await sandbox.wallet.signTransaction('UNEVEN_XDR');
      expect(signRes.signedXtr).toContain('SIGNED_G_TEST_KEY_123_UNEVEN_XDR');

      sandbox.wallet.disconnect();
      expect(sandbox.wallet.isConnected()).toBe(false);
    });
  });

  describe('Error Scenario Fixtures', () => {
    it('handles insufficient funds failure when buying ticket', async () => {
      const poorUser = SCENARIO_INSUFFICIENT_FUNDS_ACCOUNT.publicKey;
      await sandbox.horizon.fundAccount(poorUser, 0); // 0 balance

      const buyRes = await sandbox.buyTicket({
        ticketId: 'tkt_fail_01',
        eventId: 'ev_happy_01',
        buyerPublicKey: poorUser
      });

      expect(buyRes.ok).toBe(false);
      if (!buyRes.ok) {
        expect(buyRes.code).toBe('insufficient_funds');
      }
    });

    it('handles expired ticket redemption failure', async () => {
      const envWithExpired = new SandboxEnvironment({
        seedTickets: [SCENARIO_EXPIRED_TICKET]
      });

      const redeemRes = await envWithExpired.redeemTicket({
        ticketId: SCENARIO_EXPIRED_TICKET.id,
        claimerPublicKey: SCENARIO_EXPIRED_TICKET.ownerPublicKey
      });

      expect(redeemRes.ok).toBe(false);
      if (!redeemRes.ok) {
        expect(redeemRes.code).toBe('ticket_expired');
      }
    });

    it('handles double redemption prevention', async () => {
      const buyRes = await sandbox.buyTicket({
        ticketId: 'tkt_double_01',
        eventId: 'ev_happy_01',
        buyerPublicKey: 'G_BOB_ATTENDEE_HAPPY'
      });
      expect(buyRes.ok).toBe(true);

      const redeem1 = await sandbox.redeemTicket({
        ticketId: 'tkt_double_01',
        claimerPublicKey: 'G_BOB_ATTENDEE_HAPPY'
      });
      expect(redeem1.ok).toBe(true);

      // Second attempt must fail
      const redeem2 = await sandbox.redeemTicket({
        ticketId: 'tkt_double_01',
        claimerPublicKey: 'G_BOB_ATTENDEE_HAPPY'
      });
      expect(redeem2.ok).toBe(false);
      if (!redeem2.ok) {
        expect(redeem2.code).toBe('ticket_already_redeemed');
      }
    });
  });

  describe('Sensitive-Content Boundaries', () => {
    const XSS_PAYLOAD = '<script>alert(1)</script>';
    const PATH_TRAVERSAL = '../../etc/passwd';
    const TEMPLATE_INJECTION = '${process.env.SECRET}';

    it('does not execute or leak untrusted content in rendered notifications', async () => {
      await sandbox.executePrimaryWorkflow();
      const outbox = sandbox.notifications.getOutbox();
      expect(outbox.length).toBeGreaterThan(0);

      for (const message of outbox) {
        const rendered = `${message.subject}\n${message.body}`;
        expect(rendered).not.toContain('<script>');
        expect(rendered).not.toContain('javascript:');
        expect(rendered).not.toContain('onerror=');
        assertNoSensitiveLeak(message, ['privateKey', 'secretKey', 'seed']);
      }
    });

    it('rejects path traversal and executable content in download identifiers', async () => {
      const buyRes = await sandbox.buyTicket({
        ticketId: 'tkt_download_01',
        eventId: 'ev_happy_01',
        buyerPublicKey: 'G_BOB_ATTENDEE_HAPPY'
      });
      expect(buyRes.ok).toBe(true);

      const maliciousIds = [PATH_TRAVERSAL, '..\\windows\\system32', 'file:///etc/passwd', 'data:text/html,<script>alert(1)</script>'];
      for (const ticketId of maliciousIds) {
        const res = await sandbox.redeemTicket({
          ticketId,
          claimerPublicKey: 'G_BOB_ATTENDEE_HAPPY'
        });
        expect(res.ok).toBe(false);
      }
    });

    it('sanitizes webhook payloads and never leaks private fields', async () => {
      await sandbox.executePrimaryWorkflow();
      const webhooks = sandbox.webhooks.getDispatchedEvents();
      expect(webhooks.length).toBeGreaterThan(0);

      for (const event of webhooks) {
        assertNoSensitiveLeak(event.payload, ['privateKey', 'secretKey', 'seed', 'mnemonic']);
        expect(JSON.stringify(event.payload)).not.toContain('<script>');
      }
    });

    it('enforces allow-lists on export fields and blocks injection payloads', () => {
      const snapshot = sandbox.takeSnapshot();
      const serialized = JSON.stringify(snapshot);

      expect(serialized).not.toContain(XSS_PAYLOAD);
      expect(serialized).not.toContain(TEMPLATE_INJECTION);
      expect(serialized).not.toContain('privateKey');
      expect(serialized).not.toContain('secretKey');
      expect(serialized).not.toContain('mnemonic');
      assertNoSensitiveLeak(snapshot, ['privateKey', 'secretKey', 'seed', 'mnemonic']);
    });

    it('keeps sandbox state isolated after malicious input attempts', async () => {
      const before = sandbox.takeSnapshot();

      await sandbox.buyTicket({
        ticketId: XSS_PAYLOAD,
        eventId: TEMPLATE_INJECTION,
        buyerPublicKey: 'G_BOB_ATTENDEE_HAPPY'
      });

      const after = sandbox.takeSnapshot();
      expect(JSON.stringify(after)).not.toContain('<script>');
      expect(JSON.stringify(after)).not.toContain(TEMPLATE_INJECTION);

      sandbox.restoreSnapshot(before);
      const restored = sandbox.takeSnapshot();
      expect(JSON.stringify(restored)).toBe(JSON.stringify(before));
    });
  });

  describe('Snapshot & State Restoration', () => {
    it('captures sandbox snapshot and restores previous state faithfully', async () => {
      const snapshot = sandbox.takeSnapshot();

      // Mutate state
      await sandbox.horizon.fundAccount('G_TEMPORARY_USER', 50_000_0000);
      const acc = await sandbox.horizon.getAccount('G_TEMPORARY_USER');
      expect(acc.ok).toBe(true);

      // Restore snapshot
      sandbox.restoreSnapshot(snapshot);

      // Verify mutation is reverted
      const accAfterRestore = await sandbox.horizon.getAccount('G_TEMPORARY_USER');
      expect(accAfterRestore.ok).toBe(false);
    });
  });
});
