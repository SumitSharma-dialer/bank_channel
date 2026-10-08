'use strict';
// Server resources for the System page: CPU, RAM, storage. Reads /proc and statfs only (no extra packages).
// Parsers are pure (unit tested); collect() takes two CPU samples SAMPLE_MS apart.
const fs = require('fs/promises');
const os = require('os');
const { execFile } = require('child_process');

const SAMPLE_MS = 400;
// real disks only: no tmpfs / snap loop mounts / container overlays
const DISK_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'vfat', 'f2fs', 'jfs', 'reiserfs']);

// "/proc/stat" first line -> { idle, total } jiffies
function parseCpuLine(stat) {
  const f = String(stat).split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = (f[3] || 0) + (f[4] || 0);   // idle + iowait
  return { idle, total: f.slice(0, 8).reduce((s, x) => s + (x || 0), 0) };   // user..steal (guest is inside user)
}
const cpuPct = (a, b) => {
  const dt = b.total - a.total;
  return dt > 0 ? Math.round(((dt - (b.idle - a.idle)) / dt) * 1000) / 10 : 0;
};

// "/proc/meminfo" -> bytes
function parseMeminfo(txt) {
  const kb = {};
  for (const m of String(txt).matchAll(/^(\w+):\s+(\d+)/gm)) kb[m[1]] = +m[2] * 1024;
  const total = kb.MemTotal || 0, avail = kb.MemAvailable ?? kb.MemFree ?? 0;
  return { total, used: total - avail, available: avail, cached: (kb.Cached || 0) + (kb.Buffers || 0),
    swapTotal: kb.SwapTotal || 0, swapUsed: (kb.SwapTotal || 0) - (kb.SwapFree || 0) };
}

// "/proc/mounts" -> [{ device, mount, fstype }] for real disks, one per device
function parseMounts(txt) {
  const seen = new Set(), out = [];
  for (const line of String(txt).split('\n')) {
    const [device, mount, fstype] = line.split(' ');
    if (!device || !DISK_FS.has(fstype) || seen.has(device)) continue;
    seen.add(device);
    out.push({ device, mount: mount.replace(/\\040/g, ' '), fstype });
  }
  return out;
}

// "/proc/<pid>/stat" -> utime + stime jiffies (fields 14, 15; the name in () may contain spaces)
function parsePidJiffies(stat) {
  const f = String(stat).slice(String(stat).lastIndexOf(')') + 2).split(' ');
  return (+f[11] || 0) + (+f[12] || 0);
}

const read = (p) => fs.readFile(p, 'utf8').catch(() => '');
const pidof = (name) => new Promise((resolve) => {
  execFile('pidof', ['-s', name], { timeout: 2000 }, (err, out) => resolve(err ? null : +String(out).trim() || null));
});

async function collect() {
  const pid = await pidof('asterisk');
  const sample = async () => ({ cpu: parseCpuLine(await read('/proc/stat')), ast: pid ? parsePidJiffies(await read(`/proc/${pid}/stat`)) : 0 });
  const a = await sample();
  await new Promise((r) => setTimeout(r, SAMPLE_MS));
  const b = await sample();
  const cores = os.cpus().length;
  // Asterisk share of the whole box (all cores = 100 %), same scale as the CPU total
  const astPct = pid && b.cpu.total > a.cpu.total ? Math.round(((b.ast - a.ast) / (b.cpu.total - a.cpu.total)) * 1000) / 10 : null;

  const disks = [];
  for (const m of parseMounts(await read('/proc/mounts'))) {
    try {
      const s = await fs.statfs(m.mount);
      const total = s.blocks * s.bsize, free = s.bavail * s.bsize;   // bavail = what non-root can still write
      disks.push({ ...m, total, used: total - s.bfree * s.bsize, available: free });
    } catch { /* unreadable mount: skip */ }
  }

  return {
    at: Date.now(),
    cpu: { percent: cpuPct(a.cpu, b.cpu), cores, model: (os.cpus()[0] || {}).model || '', load: os.loadavg().map((x) => Math.round(x * 100) / 100), asterisk: astPct },
    memory: parseMeminfo(await read('/proc/meminfo')),
    disks,
    uptime: Math.round(os.uptime()),
    hostname: os.hostname(),
  };
}

module.exports = { collect, parseCpuLine, cpuPct, parseMeminfo, parseMounts, parsePidJiffies };
