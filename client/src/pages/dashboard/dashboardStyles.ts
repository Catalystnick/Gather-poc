export const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#0a0f16",
  color: "#fff",
  padding: 16,
};

export const cardStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 720,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  borderRadius: 12,
  border: "1px solid #2e3a4f",
  background: "#121a26",
  padding: 20,
};

export const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 22,
};

export const sectionTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 16,
};

export const textStyle: React.CSSProperties = {
  margin: 0,
  color: "#b8c4d3",
};

export const actionsStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
};

export const primaryButtonStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #396ecf",
  background: "#2d5cb5",
  color: "#fff",
  cursor: "pointer",
};

export const secondaryButtonStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #5d6775",
  background: "#1d2430",
  color: "#fff",
  cursor: "pointer",
};

export const modeToggleStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
};

export const modeButtonStyle: React.CSSProperties = {
  ...secondaryButtonStyle,
  flex: 1,
};

export const activeModeButtonStyle: React.CSSProperties = {
  ...primaryButtonStyle,
  flex: 1,
};

export const inputStyle: React.CSSProperties = {
  width: "100%",
  borderRadius: 8,
  border: "1px solid #4f5968",
  background: "#1b2532",
  color: "#fff",
  padding: "9px 10px",
};

export const errorTextStyle: React.CSSProperties = {
  margin: 0,
  color: "#fca5a5",
  fontSize: 13,
};

export const sectionStyle: React.CSSProperties = {
  marginTop: 6,
  paddingTop: 10,
  borderTop: "1px solid #2e3a4f",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

export const listStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

export const listItemStyle: React.CSSProperties = {
  color: "#d3deed",
  fontSize: 13,
};

export const inviteResultStyle: React.CSSProperties = {
  border: "1px solid #2e3a4f",
  borderRadius: 8,
  padding: 10,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

export const tokenTextStyle: React.CSSProperties = {
  margin: 0,
  color: "#d3deed",
  fontSize: 12,
  overflowWrap: "anywhere",
};
