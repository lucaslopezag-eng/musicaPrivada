import { useCallback, useLayoutEffect, useRef } from 'react';

// Ref que siempre contiene el último valor renderizado (se actualiza en la fase
// de layout, antes de que pueda llegar cualquier evento del usuario).
export function useLatestRef(value) {
  const ref = useRef(value);
  useLayoutEffect(() => { ref.current = value; });
  return ref;
}

// Callback de identidad estable que siempre ejecuta la última versión de `fn`.
// Permite pasar manejadores a componentes memorizados sin cierres obsoletos.
export function useStableCallback(fn) {
  const ref = useLatestRef(fn);
  return useCallback((...args) => ref.current?.(...args), [ref]);
}
