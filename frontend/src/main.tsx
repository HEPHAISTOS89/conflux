import React, { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './styles/base.css';
import './styles/shell.css';
import './styles/interactions.css';
import './styles/components.css';
import Shell from './components/Shell';
import Atlas from './pages/Atlas';

const Screening = lazy(() => import('./pages/Screening'));
const Corridor = lazy(() => import('./pages/Corridor'));
const Vru = lazy(() => import('./pages/Vru'));
const Intersection = lazy(() => import('./pages/Intersection'));
const Methods = lazy(() => import('./pages/Methods'));
const Platform = lazy(() => import('./pages/Platform'));
const Ask = lazy(() => import('./pages/Ask'));
const Roadmap = lazy(() => import('./pages/Roadmap'));
const Brief = lazy(() => import('./pages/Brief'));
const NotFound = lazy(() => import('./pages/NotFound'));

const wrap = (el: React.ReactElement) => <Suspense fallback={<div className="page-loading" aria-busy="true" />}>{el}</Suspense>;

// Render crashes and stale lazy chunks (404 after a deploy) land here; a reload fetches the current build.
const RouteError = () => (
  <div className="page" role="alert">
    <div className="error-box">This page failed to load, possibly because the site was updated while it was open.</div>
    <p><button className="btn" onClick={() => location.reload()}>Reload</button></p>
  </div>
);

const router = createBrowserRouter([
  {
    element: <Shell />,
    errorElement: <RouteError />,
    children: [
      { path: '/', element: <Atlas /> },
      { path: '/screening', element: wrap(<Screening />) },
      { path: '/corridors', element: wrap(<Corridor />) },
      { path: '/corridors/:id', element: wrap(<Corridor />) },
      { path: '/vru', element: wrap(<Vru />) },
      { path: '/intersections', element: wrap(<Intersection />) },
      { path: '/intersections/:id', element: wrap(<Intersection />) },
      { path: '/brief', element: wrap(<Brief />) },
      { path: '/methods', element: wrap(<Methods />) },
      { path: '/platform', element: wrap(<Platform />) },
      { path: '/roadmap', element: wrap(<Roadmap />) },
      { path: '/ask', element: wrap(<Ask />) },
      { path: '*', element: wrap(<NotFound />) },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
