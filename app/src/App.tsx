import { APP_NAME } from "./config";

/** M0 placeholder. The real layout (viewer, sidebar, terminal) arrives in M2 and follows docs/mockups/. */
export function App() {
  return (
    <main className="placeholder">
      <h1>{APP_NAME}</h1>
      <p>Desktop shell and 3D viewer arrive in milestone M2. The CAD engine works today through the cadkit CLI.</p>
    </main>
  );
}
