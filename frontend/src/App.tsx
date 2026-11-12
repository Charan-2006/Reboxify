import React from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import ThemeToggle from './components/ThemeToggle';
import LandingPage from './pages/LandingPage';
import LoginPage from './pages/LoginPage';
import UserPortal from './pages/UserPortal';
import CompanyAdminPortal from './pages/CompanyAdminPortal';
import DeliveryPartnerApp from './pages/DeliveryPartnerApp';
import CollectionCentrePortal from './pages/CollectionCentrePortal';
import AdminDashboard from './pages/AdminDashboard';

const AppRoutes: React.FC = () => {
  const { session } = useAuth();
  const { isAuthenticated, user } = session;

  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/user-login" element={<LoginPage type="user" />} />
      <Route path="/company-login" element={<LoginPage type="company" />} />
      <Route path="/partner-login" element={<LoginPage type="partner" />} />
      <Route path="/centre-login" element={<LoginPage type="centre" />} />
      <Route path="/admin-login" element={<LoginPage type="admin" />} />
      <Route path="/login" element={<Navigate to="/user-login" replace />} />
      <Route
        path="/user-portal"
        element={
          isAuthenticated && user?.role === 'CUSTOMER' ? (
            <UserPortal />
          ) : (
            <Navigate to="/user-login" replace />
          )
        }
      />
      <Route
        path="/company-admin"
        element={
          isAuthenticated &&
          (user?.role === 'MERCHANT_ADMIN' || user?.role === 'MERCHANT_STAFF') ? (
            <CompanyAdminPortal />
          ) : (
            <Navigate to="/company-login" replace />
          )
        }
      />
      <Route
        path="/delivery-partner"
        element={
          isAuthenticated && user?.role === 'DELIVERY_PARTNER' ? (
            <DeliveryPartnerApp />
          ) : (
            <Navigate to="/partner-login" replace />
          )
        }
      />
      <Route
        path="/collection-centre"
        element={
          isAuthenticated && user?.role === 'COLLECTION_CENTRE' ? (
            <CollectionCentrePortal />
          ) : (
            <Navigate to="/centre-login" replace />
          )
        }
      />
      <Route
        path="/super-admin"
        element={
          isAuthenticated && user?.role === 'ADMIN' ? (
            <AdminDashboard />
          ) : (
            <Navigate to="/admin-login" replace />
          )
        }
      />
    </Routes>
  );
};

const App: React.FC = () => {
  return (
    <ThemeProvider>
      <AuthProvider>
        <HashRouter>
          <ThemeToggle />
          <AppRoutes />
        </HashRouter>
      </AuthProvider>
    </ThemeProvider>
  );
};

export default App;
