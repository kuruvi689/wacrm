import { describe, it, expect } from 'vitest';
import { isPrivateOrReservedIp, isDeliverableUrl } from './ssrf';

describe('isPrivateOrReservedIp', () => {
  it('flags loopback / private / link-local / CGNAT IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34']) {
      expect(isPrivateOrReservedIp(ip)).toBe(false);
    }
  });

  it('flags loopback / ULA / link-local IPv6 and IPv4-mapped privates', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12::34', '::ffff:127.0.0.1']) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
    expect(isPrivateOrReservedIp('2606:4700:4700::1111')).toBe(false);
  });
});

describe('isPrivateOrReservedIp: extended ranges', () => {
  it('flags benchmarking, multicast, reserved and broadcast IPv4', () => {
    for (const ip of [
      '198.18.0.1',
      '198.19.255.254',
      '224.0.0.1',
      '239.255.255.250',
      '240.0.0.1',
      '255.255.255.255',
      '100.127.255.255',
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
    expect(isPrivateOrReservedIp('198.17.0.1')).toBe(false);
    expect(isPrivateOrReservedIp('198.20.0.1')).toBe(false);
    expect(isPrivateOrReservedIp('100.128.0.1')).toBe(false);
  });

  it('flags IPv4-mapped IPv6 in hex form', () => {
    for (const ip of ['::ffff:7f00:1', '::ffff:a00:1', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:7f00:1']) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
    expect(isPrivateOrReservedIp('::ffff:808:808')).toBe(false); // 8.8.8.8
    expect(isPrivateOrReservedIp('::ffff:8.8.8.8')).toBe(false);
  });

  it('checks the IPv4 embedded in NAT64 (64:ff9b::/96)', () => {
    expect(isPrivateOrReservedIp('64:ff9b::7f00:1')).toBe(true);
    expect(isPrivateOrReservedIp('64:ff9b::169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedIp('64:ff9b::a00:1')).toBe(true);
    expect(isPrivateOrReservedIp('64:ff9b::808:808')).toBe(false);
    expect(isPrivateOrReservedIp('64:ff9b:1::1')).toBe(true);
  });

  it('checks the IPv4 embedded in 6to4 (2002::/16)', () => {
    expect(isPrivateOrReservedIp('2002:7f00:1::1')).toBe(true);
    expect(isPrivateOrReservedIp('2002:a9fe:a9fe::')).toBe(true);
    expect(isPrivateOrReservedIp('2002:c0a8:101::1')).toBe(true);
    expect(isPrivateOrReservedIp('2002:808:808::1')).toBe(false);
  });

  it('flags IPv6 multicast and unparseable input, and allows public IPv6', () => {
    expect(isPrivateOrReservedIp('ff02::1')).toBe(true);
    expect(isPrivateOrReservedIp('::')).toBe(true);
    expect(isPrivateOrReservedIp('not-an-ip')).toBe(true);
    expect(isPrivateOrReservedIp('2606:4700:4700::1111')).toBe(false);
  });
});

describe('isDeliverableUrl', () => {
  it('rejects literal private IPs and internal names without DNS', async () => {
    expect(await isDeliverableUrl('https://127.0.0.1/hook')).toBe(false);
    expect(await isDeliverableUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(await isDeliverableUrl('https://[::1]/hook')).toBe(false);
    expect(await isDeliverableUrl('https://localhost/hook')).toBe(false);
    expect(await isDeliverableUrl('https://foo.internal/hook')).toBe(false);
    expect(await isDeliverableUrl('https://[::ffff:7f00:1]/hook')).toBe(false);
    expect(await isDeliverableUrl('https://[64:ff9b::a9fe:a9fe]/hook')).toBe(false);
    expect(await isDeliverableUrl('https://198.18.0.1/hook')).toBe(false);
  });

  it('rejects a malformed URL', async () => {
    expect(await isDeliverableUrl('not a url')).toBe(false);
  });

  it('allows a literal public IP', async () => {
    expect(await isDeliverableUrl('https://8.8.8.8/hook')).toBe(true);
  });
});
