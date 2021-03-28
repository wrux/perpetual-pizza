import { useEffect, useRef } from "react";

export const useInterval = (callback, delay) => {
  const savedCallback = useRef();

  // Latest callback
  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  // Init the interval
  useEffect(() => {
    function tick() {
      savedCallback.current();
    }
    if (delay !== null) {
      let id = setInterval(tick, delay);
      return () => clearInterval(id);
    }
  }, [delay]);
}
