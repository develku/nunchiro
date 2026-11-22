// F24: an update could not replace the running core without ending a live chat, so the old core stayed. The shell says
// so at boot (`coreKept`) and hands a new boot once the core is replaced, which takes this away.
// 11-20 guard: `coreForeign` says this run never updates or stops the core; it stays for the whole run.
import { useEffect, useState } from 'react';
import type { T } from '../i18n';

const TEXT = { coreKept: 'core.kept', coreForeign: 'core.foreign' } as const;
type Flag = keyof typeof TEXT;
const on = (flag: Flag) => window.__NUNCHIRO__?.[flag] === true;

export function CoreKept({ t, flag = 'coreKept' }: { t: T; flag?: Flag }) {
  const [show, setShow] = useState(() => on(flag));
  useEffect(() => {
    const read = () => setShow(on(flag));
    window.addEventListener('nunchiro:boot', read);
    return () => window.removeEventListener('nunchiro:boot', read);
  }, [flag]);
  if (!show) return null;
  return (
    <div className="toast" role="status">
      <span>{t(TEXT[flag])}</span>
      <button aria-label={t('settings.migrated.dismiss')} onClick={() => setShow(false)}>
        ×
      </button>
    </div>
  );
}
