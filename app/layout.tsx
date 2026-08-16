export const metadata = {
  title: 'Keep Me Around — LINE Bot',
  description: 'LINE webhook service',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}
