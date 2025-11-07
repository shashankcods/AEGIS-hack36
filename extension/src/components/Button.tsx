import React from "react";
export default function Button({ children, onClick }: React.PropsWithChildren<{ onClick?: () => void }>) {
  return <button className="button" onClick={onClick}>{children}</button>;
}
