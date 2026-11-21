// Akıncı maskotu: pikselli mavi karakter + fes.
// Durumlar: coffee (boşta, kahve içer), sleep (uzun süre boşta), thinking, writing (laptopta çalışır).

const Z = "M0 0h4v1h-4zM2 1h1v1h-1zM1 2h1v1h-1zM0 3h4v1h-4z";

const SVG = `
<svg viewBox="-1 -3 24 21" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
  <g class="m-shadow"><rect x="5" y="16.4" width="12" height="0.6" fill="#000" opacity="0.35"/></g>

  <!-- yerdeki soğumuş kahve (uyurken) -->
  <g class="m-cup-floor">
    <rect x="18.5" y="14.2" width="2.2" height="2.3" fill="#efe9de"/>
    <rect x="18.5" y="14.2" width="2.2" height="0.4" fill="#5a3418"/>
    <rect x="20.7" y="14.7" width="0.5" height="1.2" fill="#efe9de"/>
  </g>

  <g class="m-body">
    <g class="m-legs">
      <rect x="8" y="15" width="1.5" height="1.5" fill="#0b6bff"/>
      <rect x="12" y="15" width="2" height="1.5" fill="#0b6bff"/>
    </g>
    <rect x="5" y="6" width="11" height="1" fill="#0b6bff"/>
    <rect x="5" y="7" width="12" height="7" fill="#0b6bff"/>
    <rect x="6" y="14" width="10" height="1" fill="#0b6bff"/>
    <rect x="5" y="7" width="1" height="7" fill="#0957cf"/>
    <rect x="16" y="7" width="1" height="7" fill="#3d8bff"/>

    <g class="m-fez">
      <rect x="8" y="1" width="3.5" height="1" fill="#d0262d"/>
      <rect x="12.5" y="1" width="1.5" height="1" fill="#d0262d"/>
      <rect x="7" y="2" width="8" height="4" fill="#d0262d"/>
      <rect x="7" y="5.4" width="8" height="0.6" fill="#a51c22"/>
      <g class="m-tassel">
        <rect x="11.5" y="1" width="1" height="1.6" fill="#0a0c12"/>
        <rect x="12" y="2.6" width="1.5" height="1.6" fill="#0a0c12"/>
      </g>
    </g>

    <rect class="m-glow" x="5" y="6" width="12" height="6" fill="#7fd3ff"/>

    <g class="m-eyes-open">
      <g class="m-eye"><rect x="8" y="10.5" width="1.5" height="1" fill="#0a0c12"/><rect x="8.5" y="10" width="0.5" height="0.5" fill="#0a0c12"/></g>
      <g class="m-eye"><rect x="12.5" y="10.5" width="1.5" height="1" fill="#0a0c12"/><rect x="13" y="10" width="0.5" height="0.5" fill="#0a0c12"/></g>
    </g>
    <g class="m-eyes-closed">
      <rect x="8" y="11" width="1.5" height="0.4" fill="#0a0c12"/>
      <rect x="12.5" y="11" width="1.5" height="0.4" fill="#0a0c12"/>
    </g>
  </g>

  <!-- kahve fincanı (boşta) -->
  <g class="m-cup">
    <rect x="17" y="11" width="1.2" height="1" fill="#0b6bff"/>
    <rect x="18" y="10" width="2.5" height="3" fill="#efe9de"/>
    <rect x="18" y="12.4" width="2.5" height="0.6" fill="#cfc6b6"/>
    <rect x="18" y="10" width="2.5" height="0.5" fill="#6b3e1f"/>
    <rect x="20.5" y="10.7" width="0.8" height="0.4" fill="#efe9de"/>
    <rect x="21" y="10.7" width="0.4" height="1.6" fill="#efe9de"/>
    <rect x="20.5" y="11.9" width="0.8" height="0.4" fill="#efe9de"/>
    <g class="m-steam">
      <rect class="s1" x="18.6" y="8.6" width="0.4" height="0.8" fill="#c9d3e6"/>
      <rect class="s2" x="19.5" y="8" width="0.4" height="0.8" fill="#c9d3e6"/>
      <rect class="s3" x="18.9" y="7.2" width="0.4" height="0.6" fill="#c9d3e6"/>
    </g>
  </g>

  <!-- laptop (çalışırken) -->
  <g class="m-laptop">
    <rect class="m-bit b1" x="7" y="11" width="0.5" height="0.5" fill="#7fd3ff"/>
    <rect class="m-bit b2" x="11" y="11" width="0.5" height="0.5" fill="#7fd3ff"/>
    <rect class="m-bit b3" x="14.5" y="11" width="0.5" height="0.5" fill="#ffd166"/>
    <rect x="4" y="12" width="14" height="4.3" fill="#2b303c"/>
    <rect x="4" y="12" width="14" height="0.4" fill="#4a5163"/>
    <rect x="10" y="13.5" width="2" height="1.2" fill="#d0262d"/>
    <rect x="11" y="13.2" width="0.5" height="0.4" fill="#0a0c12"/>
    <rect x="2.5" y="16.3" width="17" height="0.7" fill="#8a91a3"/>
    <rect class="m-paw p1" x="3.2" y="15.4" width="1.2" height="0.9" fill="#0b6bff"/>
    <rect class="m-paw p2" x="17.6" y="15.4" width="1.2" height="0.9" fill="#0b6bff"/>
  </g>

  <!-- düşünce noktaları -->
  <g class="m-think">
    <rect class="d1" x="16.5" y="1" width="1" height="1" fill="#e6e8ee"/>
    <rect class="d2" x="18.3" y="1" width="1" height="1" fill="#e6e8ee"/>
    <rect class="d3" x="20.1" y="1" width="1" height="1" fill="#e6e8ee"/>
  </g>

  <!-- Zzz -->
  <g class="m-zzz" fill="#e6e8ee">
    <g class="z1"><path d="${Z}" transform="translate(17.6 5.6) scale(0.45)"/></g>
    <g class="z2"><path d="${Z}" transform="translate(19.2 2.4) scale(0.6)"/></g>
    <g class="z3"><path d="${Z}" transform="translate(21 -1.4) scale(0.75)"/></g>
  </g>
</svg>`;

export const STATUS_TEXT = {
  coffee: "Kahve içiyor",
  sleep: "Uyuyor… zzz",
  thinking: "Düşünüyor…",
  writing: "Laptopta yazıyor…",
};

export function createMascots(selector, onChange) {
  const nodes = [...document.querySelectorAll(selector)];
  for (const n of nodes) n.innerHTML = SVG;

  let current = null;
  function set(state) {
    if (state === current) return;
    const waking = current === "sleep" && state !== "sleep";
    current = state;
    for (const n of nodes) {
      n.dataset.state = state;
      if (waking) {
        n.classList.remove("waking");
        void n.offsetWidth;
        n.classList.add("waking");
      }
    }
    onChange?.(state);
  }
  return { set, get: () => current };
}
