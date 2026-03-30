export interface GraveNote {
  iid: string;
  x: number;
  y: number;
  headline: string;
  subline: string;
}

export interface TraderNote {
  iid: string;
  x: number;
  y: number;
  hintOffsetX: number;
  hintOffsetY: number;
  label: string;
  welcome: string;
}

export interface StatueLore {
  iid: string;
  x: number;
  y: number;
  text: string;
}
