import React from "react";

function lerpColor(a:[number,number,number], b:[number,number,number], t:number) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}
function rgbToHex(c:[number,number,number]) {
  return `#${((1<<24)+(c[0]<<16)+(c[1]<<8)+c[2]).toString(16).slice(1)}`;
}

export default function Gauge({ value, size = 110 }: { value:number; size?:number }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  const t = v / 100;
  const color = t < 0.5 ? rgbToHex(lerpColor([22,163,74],[245,158,11],t*2)) : rgbToHex(lerpColor([245,158,11],[220,38,38],(t-0.5)*2));

  const viewW = 160, viewH = 100, radius = 48, cx = viewW/2, cy = 56;
  const arcLength = Math.PI * radius;
  const dashArray = `${arcLength} ${arcLength}`;
  const dashOffset = arcLength * (1 - v/100);
  const angle = 180 - (180 * v) / 100;
  const needleLen = radius * 0.82;

  return (
    <div style={{ width: size, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
      <div style={{ textAlign: "center", lineHeight: 1 }}>
        <div style={{ fontSize: Math.round(size * 0.12), fontWeight: 700 }}>{v}</div>
        <div style={{ fontSize: Math.round(size * 0.07), color: "#6b7280" }}>Privacy score</div>
      </div>
      <svg viewBox={`0 0 ${viewW} ${viewH}`} width={size} height={(size*viewH)/viewW} preserveAspectRatio="xMidYMin meet">
        <path d={`M ${cx-radius} ${cy} A ${radius} ${radius} 0 0 0 ${cx+radius} ${cy}`} stroke="#eee" strokeWidth="10" fill="none" strokeLinecap="round" />
        <path d={`M ${cx-radius} ${cy} A ${radius} ${radius} 0 0 0 ${cx+radius} ${cy}`} stroke={color} strokeWidth="10" fill="none" strokeLinecap="round" strokeDasharray={dashArray} strokeDashoffset={dashOffset} />
        <g transform={`rotate(${angle} ${cx} ${cy})`}>
          <line x1={cx} y1={cy} x2={cx+needleLen} y2={cy} stroke={color} strokeWidth={3} strokeLinecap="round" />
          <circle cx={cx} cy={cy} r={5} fill="#111" />
          <circle cx={cx+needleLen} cy={cy} r={4} fill="#0b1220" />
        </g>
      </svg>
    </div>
  );
}
