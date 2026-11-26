import { useEffect, useState } from "react";

import { useBackend } from "../backend/context";
import type { EngineInfo } from "../backend/types";
import { APP_NAME } from "../config";
import { Dialog } from "./Dialog";
import { Logo } from "./TopBar";

interface Props {
  engine: EngineInfo | null;
  onClose: () => void;
}

export function AboutDialog({ engine, onClose }: Props) {
  const backend = useBackend();
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    backend.appVersion().then(setVersion, () => setVersion(null));
  }, [backend]);

  return (
    <Dialog title={`About ${APP_NAME}`} onClose={onClose} className="about">
      <div className="about-body">
        <div className="about-logo">
          <Logo size={44} />
        </div>
        <h3>{APP_NAME}</h3>
        <p className="muted">{version ? `Version ${version}` : " "}</p>
        <p>CAD for coding agents: describe a part, watch it build, print it.</p>
        <table className="about-versions mono small">
          <tbody>
            <tr>
              <th>cadkit</th>
              <td>{engine?.cadkit ?? "not running"}</td>
            </tr>
            <tr>
              <th>build123d</th>
              <td>{engine?.build123d ?? "not running"}</td>
            </tr>
            {engine?.python && (
              <tr>
                <th>Python</th>
                <td title={engine.python}>{engine.python}</td>
              </tr>
            )}
          </tbody>
        </table>
        <p className="muted small">Licensed under the Apache License 2.0. Models are built with build123d and OpenCASCADE.</p>
      </div>
      <footer className="dialog-foot">
        <button className="btn primary" onClick={onClose}>
          OK
        </button>
      </footer>
    </Dialog>
  );
}
