export const metadata = {
  title: "Testlane demo",
  description: "A tiny sandbox app the broker signs into.",
};

const bodyStyle = {
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  maxWidth: 560,
  margin: "64px auto",
  padding: "0 16px",
  lineHeight: 1.5,
  color: "#20283D",
  background: "#F4F6FC",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={bodyStyle}>
        <header style={{ marginBottom: 32 }}>
          <a href="/" aria-label="Testlane demo home">
            <img src="/brand/testlane-logo-light.svg" alt="" width={180} style={{ height: "auto", display: "block" }} />
          </a>
        </header>
        {children}
      </body>
    </html>
  );
}
