import React, { useState, useEffect, useRef } from 'react';
import Pizza from './pizza.gif';
import './App.css';

// Loading component
function Loading() {
  return <div className="loading">
    <p>Loading Pizza</p>
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

// Display the loop counter
function Counter() {
  let [count, setCount] = useState(0);

  // GIF is 2 seconds long
  useInterval(() => {
    setCount(count + 1);
  }, 2000);

  useEffect(() => {
    document.title = "Perpetual Pizza: " + count
  });

  return <div className="pizza-counter">
    <p className="title">Pizza watched</p>
    <p className="count">{count}</p>
  </div>
}

// Display the credit
function Credit() {
  return (
    <div className="credit">
      <a href="https://bloke.blog/" target="_blank" rel="noopener noreferrer" >Bloke</a>
      <a href="http://sheepfilms.co.uk/" target="_blank" rel="noopener noreferrer" >SheepFilms</a>
    </div>
  )
}

// Pizza App
function App() {
  const [ spinner, setSpinner ] = useState(true);

  const pizzaBackground = {
    backgroundImage: `url(${Pizza})`
  }

  useEffect(() => {
    setTimeout(() => setSpinner(false), 1000)
  }, []);

  if (spinner) {
    return <Loading />
  }
  
  return <div className="app" style={pizzaBackground}>
    <Counter />
    <Credit />
  </div>
}

export default App;