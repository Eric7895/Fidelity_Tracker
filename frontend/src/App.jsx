import { BrowserRouter, Route, Routes } from 'react-router';
import DashboardPage from './pages/DashboardPage';
import StockDetailsPage from './pages/StockDetailsPage';
import NotFoundPage from './pages/NotFoundPage';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/stocks/:symbol" element={<StockDetailsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;