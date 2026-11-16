import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Lekvero — ผลสลากกินแบ่งรัฐบาล',
  description:
    'Informational Thai Government Lottery results. No ticket sales, betting or payments.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="th">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          margin: '0 auto',
          maxWidth: 720,
          padding: 16,
        }}
      >
        {children}
        <footer style={{ marginTop: 48, fontSize: 13, color: '#555' }}>
          <p>
            เว็บไซต์นี้ให้ข้อมูลเท่านั้น ไม่มีการจำหน่ายสลาก รับแทง หรือรับชำระเงิน
            โปรดตรวจสอบผลรางวัลกับสำนักงานสลากกินแบ่งรัฐบาลทุกครั้ง
          </p>
          <p>
            Information only — not affiliated with the Government Lottery Office (GLO). Always
            verify results with GLO.
          </p>
        </footer>
      </body>
    </html>
  );
}
