import { hydrateRoot } from 'react-dom/client';
import Home from './app/page';
import Privacy from './app/privacy/page';
import Manage from './app/manage/page';
const page=document.body.dataset.page;
hydrateRoot(document.getElementById('root')!,page==='privacy'?<Privacy/>:page==='manage'?<Manage/>:<Home/>);
