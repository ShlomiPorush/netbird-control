import { useEffect, useLayoutEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAppConfig } from '@/lib/queries';
import { setTimeFormat } from '@/lib/logfmt';

/** What every page shell sets up: the configured time format, the window title, and the scroll
 * position of a newly opened page. Returns the app config. */
export function useAppShell() {
  const cfg = useAppConfig().data;
  // Apply the configured timezone / date format / clock before child pages render
  // their timestamps.
  setTimeFormat({ timeZone: cfg?.timeZone, dateFormat: cfg?.dateFormat, hour12: cfg?.hour12 });
  useEffect(() => { if (cfg?.appName) document.title = cfg.appName; }, [cfg?.appName]);

  // Reset scroll to the top when navigating to a different page (menu navigation), so a page
  // never opens mid-scroll at the previous page's position. Keyed on pathname only, so in-page
  // tab switches (`?tab=…`) keep their position. useLayoutEffect scrolls before paint (no flash).
  const { pathname } = useLocation();
  useLayoutEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return cfg;
}
