using Microsoft.EntityFrameworkCore;
using TaskFlow.Application.Projects.Commands.CreateProject;
using TaskFlow.Infrastructure.Persistence;
using Xunit;

namespace TaskFlow.Tests.Application.Projects;

public class CreateProjectCommandHandlerTests
{
    private static TaskFlowDbContext CreateContext(string dbName)
    {
        var options = new DbContextOptionsBuilder<TaskFlowDbContext>()
            .UseInMemoryDatabase(dbName)
            .Options;
        return new TaskFlowDbContext(options);
    }

    [Fact]
    public async Task Handle_ValidCommand_CreatesProjectAndReturnsId()
    {
        await using var context = CreateContext(nameof(Handle_ValidCommand_CreatesProjectAndReturnsId));
        var handler = new CreateProjectCommandHandler(context);

        var id = await handler.Handle(new CreateProjectCommand("My Project", "A description"), default);

        Assert.True(id > 0);
        var project = await context.Projects.FindAsync(id);
        Assert.NotNull(project);
        Assert.Equal("My Project", project.Name);
        Assert.Equal("A description", project.Description);
    }

    [Fact]
    public void Validator_EmptyName_FailsValidation()
    {
        var validator = new CreateProjectCommandValidator();
        var result = validator.Validate(new CreateProjectCommand(string.Empty, null));
        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.PropertyName == "Name");
    }

    [Fact]
    public void Validator_ValidName_PassesValidation()
    {
        var validator = new CreateProjectCommandValidator();
        var result = validator.Validate(new CreateProjectCommand("Valid Name", null));
        Assert.True(result.IsValid);
    }
}
