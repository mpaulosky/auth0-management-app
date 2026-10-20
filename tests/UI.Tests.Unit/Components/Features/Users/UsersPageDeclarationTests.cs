// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     UsersPageDeclarationTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using System.Reflection;

using Domain.Constants;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Web;

using UI.Components.Features.Users;

namespace UI.Tests.Unit.Components.Features.Users;

public class UsersPageDeclarationTests
{
	[Fact]
	public void UsersPage_Route_IsAdminUsers()
	{
		// Arrange

		// Act
		RouteAttribute? route = typeof(UsersPage).GetCustomAttribute<RouteAttribute>();

		// Assert
		route.Should().NotBeNull();
		route!.Template.Should().Be("/admin/users");
	}

	[Fact]
	public void UsersPage_Authorization_RequiresTheAdminPolicyOnThePageItself()
	{
		// Arrange

		// Act
		AuthorizeAttribute? authorize = typeof(UsersPage).GetCustomAttribute<AuthorizeAttribute>();

		// Assert
		authorize.Should().NotBeNull("hiding a button isn't a security boundary: the page carries [Authorize]");
		authorize!.Policy.Should().Be(ApplicationConstants.AdminPolicy);
	}

	[Fact]
	public void UsersPage_RenderMode_IsInteractiveServer()
	{
		// Arrange

		// Act
		RenderModeAttribute? renderMode = typeof(UsersPage).GetCustomAttribute<RenderModeAttribute>();

		// Assert
		renderMode.Should().NotBeNull();
		renderMode!.Mode.Should().BeOfType<InteractiveServerRenderMode>();
	}

	[Fact]
	public void UsersPageModule_Source_WritesTheUrlWithHistoryReplaceState()
	{
		// Arrange

		// Act
		string module = RepositoryFiles.ReadAllText("src", "UI", "Components", "Features", "Users", "UsersPage.razor.js");

		// Assert
		module.Should().Contain("export function replaceUrl");
		module.Should().Contain("history.replaceState");
		module.Should().NotContain("pushState");
	}
}
