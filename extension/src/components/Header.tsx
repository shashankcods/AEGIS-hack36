import React from "react";

export default function Header({ title = "Aegis", subtitle = "Privacy Guard" }: { title?: string; subtitle?: string }) {
  return (
    <div className="header">
      <div className="logo">A</div>
      <div>
        <div className="title">{title}</div>
        <div className="subtitle">{subtitle}</div>
      </div>
    </div>
  );
}
