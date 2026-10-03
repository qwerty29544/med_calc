import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Check,
  LoaderCircle,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import Link from 'next/link';
export function Loading({ text = 'Загружаем данные…' }: { text?: string }) {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={22} />
      <span>{text}</span>
    </div>
  );
}
export function ErrorNotice({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="notice danger" role="alert">
      <AlertCircle size={20} />
      <div>
        {message}
        {retry && (
          <button className="text-button" onClick={retry}>
            Повторить
          </button>
        )}
      </div>
    </div>
  );
}
export function DemoNotice() {
  return (
    <div className="demo-notice">
      <AlertTriangle size={15} />
      <span>
        <strong>Демонстрационный режим · DRAFT</strong>
        <span className="demo-detail"> · Для технической проверки, не для клинических назначений.</span>
      </span>
      <span className="demo-pill">v0.1.0</span>
    </div>
  );
}
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'blue';
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function PageTitle({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  );
}
export function Empty({
  title,
  text,
  href,
  action,
}: {
  title: string;
  text: string;
  href?: string;
  action?: string;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Sparkles size={26} />
      </div>
      <h2>{title}</h2>
      <p>{text}</p>
      {href && (
        <Link href={href} className="button primary">
          {action || 'Новый расчёт'}
          <ArrowRight size={16} />
        </Link>
      )}
    </div>
  );
}
export function PrivacyNote() {
  return (
    <div className="privacy-note">
      <ShieldCheck size={17} />
      <span>Только обезличенные клинические данные. Не вводите ФИО и другие идентификаторы пациента.</span>
    </div>
  );
}
export function Success({ children }: { children: React.ReactNode }) {
  return (
    <div className="success-note" role="status">
      <Check size={16} />
      {children}
    </div>
  );
}
