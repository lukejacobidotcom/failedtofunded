import {renderToString} from 'react-dom/server';
import Home from './app/page';
import Privacy from './app/privacy/page';
import Manage from './app/manage/page';
export function render(page:string){return renderToString(page==='privacy'?<Privacy/>:page==='manage'?<Manage/>:<Home/>);}
