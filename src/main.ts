import "./style.css";
import { SIM_VERSION } from "./sim/version";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <h1>Ageofwind</h1>
  <p>AoE2-better browser RTS — skeleton alive. sim v${SIM_VERSION}</p>
`;
