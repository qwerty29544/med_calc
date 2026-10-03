import type { Metadata } from 'next';
import { Providers } from '../components/providers';
import './globals.css';
export const metadata: Metadata = {
  title: 'Клиника · Поддержка врачебных решений',
  description: 'Объяснимая поддержка решений по антибактериальной терапии',
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
