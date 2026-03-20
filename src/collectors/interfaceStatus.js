class InterfaceStatusCollector {
  constructor({ ros, io, pollMs, state }) {
    this.ros = ros; this.io = io; this.pollMs = pollMs || 5000;
    this.state = state; this.timer = null;
  }

  parsePoePowerWatts(entry) {
    if (!entry || typeof entry !== "object") return null;
    const candidates = [
      entry["poe-out-power"],
      entry["power"],
      entry["power-consumption"],
      entry["power-draw"],
      entry["poe-power"],
    ];
    for (const raw of candidates) {
      if (raw == null || raw === "") continue;
      const n = parseFloat(String(raw).replace(/[^\d.\-]/g, ""));
      if (!Number.isFinite(n)) continue;
      const lower = String(raw).toLowerCase();
      if (lower.includes("mw")) return Math.round((n / 1000) * 10) / 10;
      if (n > 2000) return Math.round((n / 1000) * 10) / 10;
      return Math.round(n * 10) / 10;
    }

    // Fallback for devices that expose only current/voltage counters.
    const currentRaw = entry["poe-out-current"] || entry["current"] || entry["poe-current"];
    const voltageRaw = entry["poe-out-voltage"] || entry["voltage"] || entry["poe-voltage"];
    if (currentRaw != null && currentRaw !== "" && voltageRaw != null && voltageRaw !== "") {
      const cStr = String(currentRaw).toLowerCase();
      const vStr = String(voltageRaw).toLowerCase();
      let currentA = parseFloat(cStr.replace(/[^\d.\-]/g, ""));
      let voltageV = parseFloat(vStr.replace(/[^\d.\-]/g, ""));
      if (Number.isFinite(currentA) && Number.isFinite(voltageV)) {
        if (cStr.includes("ma") || currentA > 50) currentA = currentA / 1000;
        if (vStr.includes("mv") || voltageV > 1000) voltageV = voltageV / 1000;
        const watts = currentA * voltageV;
        if (Number.isFinite(watts) && watts >= 0) return Math.round(watts * 10) / 10;
      }
    }

    return null;
  }

  buildPoeByIface(poeItems) {
    const byIface = {};
    for (const p of (poeItems || [])) {
      if (!p || typeof p !== "object") continue;
      const name = p.interface || p.name || "";
      if (!name) continue;
      const powerW = this.parsePoePowerWatts(p);
      const status = String(p["poe-out-status"] || p.status || "").toLowerCase();
      const rawPoeOut = String(p["poe-out"] || "").toLowerCase();
      const hasPoeSignal = [
        p["poe-out-status"],
        p["poe-out-power"],
        p["poe-out-current"],
        p["poe-out-voltage"],
        p["power"],
      ].some(v => v != null && v !== "");
      const statusMarksUnsupported = ["no-pse", "unsupported", "not-supported", "none", "n/a"].includes(status);
      const isPoECapable = [
        p["poe-in"],
      ].some(v => v != null && v !== "") ||
        (hasPoeSignal && !statusMarksUnsupported) ||
        powerW != null ||
        (!!rawPoeOut && rawPoeOut !== "none");
      byIface[name] = {
        poeCapable: isPoECapable,
        poeStatus: status,
        poePowerW: powerW,
      };
    }
    return byIface;
  }

  async tick() {
    if (!this.ros.connected) return;
    const [ifRes, addrRes, poeRes] = await Promise.allSettled([
      this.ros.write("/interface/print", ["=stats="]),
      this.ros.write("/ip/address/print"),
      this.ros.write("/interface/ethernet/poe/print"),
    ]);
    const ifaces = ifRes.status === "fulfilled" ? (ifRes.value || []) : [];
    const addrs = addrRes.status === "fulfilled" ? (addrRes.value || []) : [];
    const poeItems = poeRes.status === "fulfilled" ? (poeRes.value || []) : [];
    const poeByIface = this.buildPoeByIface(poeItems);
    const ipByIface = {};
    for (const a of addrs) {
      const n = a.interface || "";
      if (!ipByIface[n]) ipByIface[n] = [];
      ipByIface[n].push(a.address || "");
    }
    const interfaces = ifaces.map(i => ({
      name: i.name || "",
      type: i.type || "ether",
      running: i.running === "true" || i.running === true,
      disabled: i.disabled === "true" || i.disabled === true,
      comment: i.comment || "",
      macAddr: i["mac-address"] || "",
      rxBytes: parseInt(i["rx-byte"] || "0", 10),
      txBytes: parseInt(i["tx-byte"] || "0", 10),
      rxMbps: Math.round((parseFloat(i["rx-bits-per-second"] || "0") / 1e6) * 10) / 10,
      txMbps: Math.round((parseFloat(i["tx-bits-per-second"] || "0") / 1e6) * 10) / 10,
      ips: ipByIface[i.name] || [],
      poeCapable: Boolean((poeByIface[i.name] || {}).poeCapable),
      poeStatus: (poeByIface[i.name] || {}).poeStatus || "",
      poePowerW: (poeByIface[i.name] || {}).poePowerW,
    }));
    this.io.emit("ifstatus:update", { ts: Date.now(), interfaces });
    this.state.lastIfStatusTs = Date.now();
  }
  start() {
    const run = async () => { try { await this.tick(); } catch (e) { console.error("[ifstatus]", e && e.message ? e.message : e); } };
    run();
    this.timer = setInterval(run, this.pollMs);
    this.ros.on("close", () => { if (this.timer) { clearInterval(this.timer); this.timer = null; } });
    this.ros.on("connected", () => { this.timer = this.timer || setInterval(run, this.pollMs); run(); });
  }
}
module.exports = InterfaceStatusCollector;
