import { useEffect } from 'react';
import { Redirect, Route, Switch, useLocation } from 'wouter';
import { setUnauthorizedHandler } from './lib/api';
import { queryClient, useAuthStatus } from './lib/queries';
import { Layout } from './pages/Layout';
import { Login } from './pages/Login';
import { Profile } from './pages/Profile';
import { Projects } from './pages/Projects';
import { Spinner } from './ui';

export function App() {
  const [, navigate] = useLocation();
  const status = useAuthStatus();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      queryClient.clear();
      navigate('/login');
    });
  }, [navigate]);

  if (status.isLoading) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner />
      </div>
    );
  }
  const signedIn = Boolean(status.data?.user);
  return (
    <Switch>
      <Route path="/login">{signedIn ? <Redirect to="/" /> : <Login />}</Route>
      <Route path="/profile">{signedIn ? <Profile /> : <Redirect to="/login" />}</Route>
      <Route path="/p/:project" nest>
        {signedIn ? <Layout /> : <Redirect to="/login" />}
      </Route>
      <Route path="/">{signedIn ? <Projects /> : <Redirect to="/login" />}</Route>
      <Route>
        <Redirect to="/" />
      </Route>
    </Switch>
  );
}
