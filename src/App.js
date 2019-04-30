import React, { useState, useEffect, useRef } from 'react';
import './App.css';

// Loading component
function Loading() {
  return <div>
    <h1>Loadig Pizza</h1>
  </div>
}

function useInterval(callback, delay) {
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

// Display a counter
function Counter() {
  let [count, setCount] = useState(0);

  useInterval(() => {
    // Your custom logic here
    setCount(count + 1);
  }, 1000);

  useEffect(() => {
    document.title = "Perpetual Pizza:" + count
  });

  return <div id="pizza-counter">
    <p className="title">Pizza watched</p>
    <p className="count">{count}</p>
  </div>
}

// Pizza App
function App() {
  const [ spinner, setSpinner ] = useState(true);

  useEffect(() => {
    setTimeout(() => setSpinner(false), 1000)
  }, []);
  
  if (spinner) {
    return <Loading />
  }
  
  return <div id="app">
    <Counter />
  </div>
}

export default App;