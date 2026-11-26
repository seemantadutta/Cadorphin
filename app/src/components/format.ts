import type { PrinterProfile } from "../backend/types";

/** "256 × 256 × 256 mm" */
export function volumeText(p: Pick<PrinterProfile, "build_volume_mm">) {
  return p.build_volume_mm.map((v) => `${+v.toFixed(1)}`).join(" × ") + " mm";
}
