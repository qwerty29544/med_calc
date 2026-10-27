import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { Providers } from '../components/providers';
import './globals.css';
import './clinical-paper.css';
const golos = localFont({
  src: './fonts/golos-text.ttf',
  variable: '--font-interface',
  weight: '400 900',
  display: 'swap',
});
const serif = localFont({
  src: './fonts/pt-serif.ttf',
  variable: '--font-heading',
  weight: '400',
  display: 'swap',
});
export const metadata: Metadata = {
  title: 'Клинический расчёт',
  description: 'Объяснимая поддержка решений по антибактериальной терапии',
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru" className={`${golos.variable} ${serif.variable}`} data-theme="light">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
